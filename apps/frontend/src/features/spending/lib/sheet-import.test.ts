import { describe, expect, it } from "vitest";
import {
  distinctNames,
  matchByName,
  parseExpenseRows,
  parseMutasiRows,
  parseRupiah,
  parseSheetDate,
} from "./sheet-import";

describe("parseRupiah", () => {
  it.each([
    ["Rp8.000,00", 8000],
    ["Rp100.000,00", 100000],
    ["Rp 1.250.000", 1250000],
    ["8.000", 8000],
    ["8000", 8000],
    ["8,5", 8.5],
    ["8.5", 8.5],
    ["-Rp5.000,00", -5000],
    ["(Rp5.000,00)", -5000],
    ["0", 0],
  ])("parses %s", (input, expected) => {
    expect(parseRupiah(input)).toBe(expected);
  });

  it.each(["", "  ", "abc", "Rp", "12abc"])("rejects %j", (input) => {
    expect(parseRupiah(input)).toBeNull();
  });

  it("rejects null and undefined", () => {
    expect(parseRupiah(null)).toBeNull();
    expect(parseRupiah(undefined)).toBeNull();
  });
});

describe("parseSheetDate", () => {
  it("accepts ISO and Indonesian day-first dates", () => {
    expect(parseSheetDate("2026-11-12")).toBe("2026-11-12");
    expect(parseSheetDate("12/11/2026")).toBe("2026-11-12");
    expect(parseSheetDate("2-1-2026")).toBe("2026-01-02");
  });

  it("rejects impossible or unknown dates", () => {
    expect(parseSheetDate("2026-02-30")).toBeNull();
    expect(parseSheetDate("nov 12")).toBeNull();
    expect(parseSheetDate("")).toBeNull();
    expect(parseSheetDate(undefined)).toBeNull();
  });
});

describe("parseExpenseRows", () => {
  const headers = ["Tanggal", "Item", "Nominal", "Kategori", "Sumber"];

  it("maps sheet rows to withdrawals", () => {
    const { drafts, errors, skipped } = parseExpenseRows(headers, [
      ["2026-11-12", "Cilor", "Rp8.000,00", "Makanan", "Cash"],
      ["2026-11-14", "Indomaret", "Rp45.000,00", "Belanja", "SeaBank"],
    ]);
    expect(errors).toEqual([]);
    expect(skipped).toBe(0);
    expect(drafts).toEqual([
      {
        row: 1,
        kind: "expense",
        type: "WITHDRAWAL",
        date: "2026-11-12",
        amount: 8000,
        note: "Cilor",
        categoryName: "Makanan",
        accountName: "Cash",
      },
      expect.objectContaining({ row: 2, amount: 45000, accountName: "SeaBank" }),
    ]);
  });

  it("ignores the side tables that share the sheet's rows", () => {
    const wide = [
      "2026-11-16",
      "Cilok",
      "Rp10.000,00",
      "Makanan",
      "SeaBank",
      "",
      "",
      "Cash",
      "Rp650.000,00",
    ];
    const { drafts, errors } = parseExpenseRows(headers, [wide]);
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(1);
  });

  it("skips blank rows and reports bad ones with a reason", () => {
    const { drafts, errors, skipped } = parseExpenseRows(headers, [
      ["", "", "", "", ""],
      ["bukan tanggal", "A", "Rp1.000,00", "Makanan", "Cash"],
      ["2026-11-12", "B", "abc", "Makanan", "Cash"],
      ["2026-11-12", "C", "Rp1.000,00", "Makanan", ""],
    ]);
    expect(drafts).toEqual([]);
    expect(skipped).toBe(1);
    expect(errors).toEqual([
      { row: 2, reason: "date" },
      { row: 3, reason: "amount" },
      { row: 4, reason: "account" },
    ]);
  });

  it("leaves an empty category unset", () => {
    const { drafts } = parseExpenseRows(headers, [["2026-11-12", "X", "Rp1.000,00", "", "Cash"]]);
    expect(drafts[0].categoryName).toBeUndefined();
  });
});

describe("parseMutasiRows", () => {
  const headers = ["Tanggal", "Jenis", "Dari", "Ke", "Nominal", "Catatan"];

  it("maps income to a deposit on the destination account", () => {
    const { drafts, errors } = parseMutasiRows(headers, [
      ["2026-11-16", "Pemasukan", "", "BCA", "Rp100.000,00", "Profit"],
    ]);
    expect(errors).toEqual([]);
    expect(drafts).toEqual([
      {
        row: 1,
        kind: "mutasi",
        type: "DEPOSIT",
        date: "2026-11-16",
        amount: 100000,
        note: "Profit",
        accountName: "BCA",
        toAccountName: undefined,
      },
    ]);
  });

  it("maps a transfer to both accounts and requires them", () => {
    const { drafts, errors } = parseMutasiRows(headers, [
      ["2026-11-16", "Transfer", "BCA", "Trading", "Rp250.000,00", ""],
      ["2026-11-16", "Transfer", "BCA", "", "Rp250.000,00", ""],
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      type: "TRANSFER",
      accountName: "BCA",
      toAccountName: "Trading",
    });
    expect(errors).toEqual([{ row: 2, reason: "account" }]);
  });

  it("rejects an unknown Jenis", () => {
    const { errors } = parseMutasiRows(headers, [
      ["2026-11-16", "Lainnya", "BCA", "", "Rp1.000,00", ""],
    ]);
    expect(errors).toEqual([{ row: 1, reason: "type" }]);
  });
});

describe("name helpers", () => {
  it("collects distinct names case-insensitively", () => {
    const { drafts } = parseExpenseRows(
      ["Tanggal", "Item", "Nominal", "Kategori", "Sumber"],
      [
        ["2026-11-12", "A", "Rp1.000,00", "Makanan", "Cash"],
        ["2026-11-13", "B", "Rp1.000,00", "makanan", "cash"],
        ["2026-11-14", "C", "Rp1.000,00", "Belanja", "SeaBank"],
      ],
    );
    expect(distinctNames(drafts, (d) => [d.accountName])).toEqual(["Cash", "SeaBank"]);
    expect(distinctNames(drafts, (d) => [d.categoryName])).toEqual(["Makanan", "Belanja"]);
  });

  it("matches by trimmed, case-insensitive name", () => {
    const accounts = [
      { id: "a", name: "Cash" },
      { id: "b", name: "SeaBank" },
    ];
    expect(matchByName(" seabank ", accounts)?.id).toBe("b");
    expect(matchByName("BCA", accounts)).toBeUndefined();
  });
});
