/**
 * Maps rows exported from a personal expense spreadsheet (Indonesian layout) to
 * cash-activity drafts. Pure functions only: parsing, validation and grouping.
 * Nothing here talks to the backend; the import dialog does that.
 *
 * Expense sheet columns: Tanggal | Item | Nominal | Kategori | Sumber
 * Mutasi sheet columns:  Tanggal | Jenis | Dari | Ke | Nominal | Catatan
 */

export type SheetRowKind = "expense" | "mutasi";

export type SheetDraftType = "WITHDRAWAL" | "DEPOSIT" | "TRANSFER";

export interface SheetDraft {
  /** 1-based data row number, for error messages. */
  row: number;
  kind: SheetRowKind;
  type: SheetDraftType;
  /** yyyy-MM-dd */
  date: string;
  amount: number;
  note: string;
  /** Category name as written in the sheet (expenses only). */
  categoryName?: string;
  /** Account name as written in the sheet. For a transfer, the source side. */
  accountName: string;
  /** Destination account name (transfers only). */
  toAccountName?: string;
}

export interface SheetRowError {
  row: number;
  reason: "date" | "amount" | "account" | "type";
}

export interface SheetParseResult {
  drafts: SheetDraft[];
  errors: SheetRowError[];
  /** Blank or example rows that were left out on purpose. */
  skipped: number;
}

/**
 * Parses "Rp8.000,00", "Rp 1.250.000", "8.000,50", "8000" or "-Rp5.000,00".
 * Dot groups thousands and comma is the decimal mark, as in Indonesian locale.
 * Returns null when the text is not a number.
 */
export function parseRupiah(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  let text = raw.trim();
  if (!text) return null;

  const negative = /^\(.*\)$/.test(text) || text.includes("-");
  text = text
    .replace(/^\(|\)$/g, "")
    .replace(/Rp\.?/gi, "")
    .replace(/[\s-]/g, "");
  if (!text || !/^[\d.,]+$/.test(text)) return null;

  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  let normalized: string;
  if (lastComma >= 0) {
    // Comma is the decimal mark; any dots before it are thousands separators.
    normalized = `${text.slice(0, lastComma).replace(/[.,]/g, "")}.${text.slice(lastComma + 1)}`;
  } else if (lastDot >= 0 && !/^\d{1,3}(\.\d{3})+$/.test(text)) {
    // A lone dot that does not form thousands groups is a decimal point ("8.5").
    normalized = text;
  } else {
    normalized = text.replace(/\./g, "");
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/** Accepts yyyy-MM-dd, dd/MM/yyyy and dd-MM-yyyy. Returns yyyy-MM-dd or null. */
export function parseSheetDate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const text = raw.trim();
  let year: number;
  let month: number;
  let day: number;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const local = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (iso) {
    [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (local) {
    [day, month, year] = [Number(local[1]), Number(local[2]), Number(local[3])];
  } else {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const norm = (value: string | undefined) => (value ?? "").trim();

function columnIndex(headers: string[], ...names: string[]): number {
  const wanted = names.map((n) => n.toLowerCase());
  return headers.findIndex((h) => wanted.includes(h.trim().toLowerCase()));
}

const EXAMPLE_TYPES = new Set(["contoh", "example"]);

/** Expense sheet: one WITHDRAWAL per row. */
export function parseExpenseRows(headers: string[], rows: string[][]): SheetParseResult {
  const col = {
    date: columnIndex(headers, "Tanggal", "Date"),
    item: columnIndex(headers, "Item", "Keterangan"),
    amount: columnIndex(headers, "Nominal", "Jumlah", "Amount"),
    category: columnIndex(headers, "Kategori", "Category"),
    source: columnIndex(headers, "Sumber", "Akun", "Account"),
  };

  const drafts: SheetDraft[] = [];
  const errors: SheetRowError[] = [];
  let skipped = 0;

  rows.forEach((cells, i) => {
    const row = i + 1;
    const get = (index: number) => (index >= 0 ? norm(cells[index]) : "");
    const blank = !get(col.date) && !get(col.item) && !get(col.amount);
    if (blank) {
      skipped += 1;
      return;
    }

    const date = parseSheetDate(get(col.date));
    if (!date) return void errors.push({ row, reason: "date" });
    const amount = parseRupiah(get(col.amount));
    if (amount == null || amount === 0) return void errors.push({ row, reason: "amount" });
    const accountName = get(col.source);
    if (!accountName) return void errors.push({ row, reason: "account" });

    drafts.push({
      row,
      kind: "expense",
      type: amount < 0 ? "DEPOSIT" : "WITHDRAWAL",
      date,
      amount: Math.abs(amount),
      note: get(col.item),
      categoryName: get(col.category) || undefined,
      accountName,
    });
  });

  return { drafts, errors, skipped };
}

/** Maps the Jenis column to a draft type. */
function mutasiType(jenis: string): SheetDraftType | null {
  switch (jenis.trim().toLowerCase()) {
    case "pemasukan":
    case "income":
      return "DEPOSIT";
    case "pengeluaran":
    case "expense":
      return "WITHDRAWAL";
    case "transfer":
    case "pindah":
      return "TRANSFER";
    default:
      return null;
  }
}

/** Mutasi sheet: income, expense or transfer between accounts. */
export function parseMutasiRows(headers: string[], rows: string[][]): SheetParseResult {
  const col = {
    date: columnIndex(headers, "Tanggal", "Date"),
    type: columnIndex(headers, "Jenis", "Type"),
    from: columnIndex(headers, "Dari", "From"),
    to: columnIndex(headers, "Ke", "To"),
    amount: columnIndex(headers, "Nominal", "Jumlah", "Amount"),
    note: columnIndex(headers, "Catatan", "Note"),
  };

  const drafts: SheetDraft[] = [];
  const errors: SheetRowError[] = [];
  let skipped = 0;

  rows.forEach((cells, i) => {
    const row = i + 1;
    const get = (index: number) => (index >= 0 ? norm(cells[index]) : "");
    const jenis = get(col.type);
    if ((!get(col.date) && !jenis && !get(col.amount)) || EXAMPLE_TYPES.has(jenis.toLowerCase())) {
      skipped += 1;
      return;
    }

    const type = mutasiType(jenis);
    if (!type) return void errors.push({ row, reason: "type" });
    const date = parseSheetDate(get(col.date));
    if (!date) return void errors.push({ row, reason: "date" });
    const amount = parseRupiah(get(col.amount));
    if (amount == null || amount <= 0) return void errors.push({ row, reason: "amount" });

    // Income lands in "Ke"; an expense leaves "Dari"; a transfer needs both.
    const from = get(col.from);
    const to = get(col.to);
    const accountName = type === "DEPOSIT" ? to : from;
    if (!accountName || (type === "TRANSFER" && !to)) {
      return void errors.push({ row, reason: "account" });
    }

    drafts.push({
      row,
      kind: "mutasi",
      type,
      date,
      amount,
      note: get(col.note),
      accountName,
      toAccountName: type === "TRANSFER" ? to : undefined,
    });
  });

  return { drafts, errors, skipped };
}

/** Distinct, trimmed names used by the drafts, for the account/category mapping step. */
export function distinctNames(
  drafts: SheetDraft[],
  pick: (draft: SheetDraft) => (string | undefined)[],
): string[] {
  const seen = new Map<string, string>();
  for (const draft of drafts) {
    for (const name of pick(draft)) {
      const trimmed = name?.trim();
      if (trimmed && !seen.has(trimmed.toLowerCase())) seen.set(trimmed.toLowerCase(), trimmed);
    }
  }
  return [...seen.values()];
}

/** Case-insensitive match of a sheet name against `{ id, name }` candidates. */
export function matchByName<T extends { id: string; name: string }>(
  name: string,
  candidates: T[],
): T | undefined {
  const wanted = name.trim().toLowerCase();
  return candidates.find((c) => c.name.trim().toLowerCase() === wanted);
}
