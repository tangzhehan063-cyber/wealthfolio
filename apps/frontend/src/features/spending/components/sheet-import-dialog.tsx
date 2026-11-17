import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui";

import { createActivity, parseCsv } from "@/adapters";
import { useAccounts } from "@/hooks/use-accounts";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import { QueryKeys } from "@/lib/query-keys";
import { getCategoryLabel } from "@/lib/taxonomy-labels";
import { assignActivityCategory } from "../adapters/cash-activities";
import { invalidateSpendingCaches } from "../lib/invalidation";
import {
  distinctNames,
  matchByName,
  parseExpenseRows,
  parseMutasiRows,
  type SheetDraft,
  type SheetParseResult,
  type SheetRowKind,
} from "../lib/sheet-import";

const CATEGORY_TAXONOMY_ID = "spending_categories";
const NO_CATEGORY = "__none__";

interface SheetImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ImportSummary {
  imported: number;
  duplicates: number;
  failed: number;
}

export function SheetImportDialog({ open, onOpenChange }: SheetImportDialogProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { accounts = [] } = useAccounts();
  const { data: taxonomy } = useTaxonomy(CATEGORY_TAXONOMY_ID);

  const [kind, setKind] = useState<SheetRowKind>("expense");
  const [parsed, setParsed] = useState<SheetParseResult | null>(null);
  const [accountMap, setAccountMap] = useState<Record<string, string>>({});
  const [categoryMap, setCategoryMap] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const cashAccounts = useMemo(
    () => accounts.filter((a) => a.accountType === "CASH" || a.accountType === "CREDIT_CARD"),
    [accounts],
  );
  const categories = useMemo(() => taxonomy?.categories ?? [], [taxonomy]);

  // Transfers need a linked pair of legs, which this import does not create yet.
  const importable = useMemo(
    () => parsed?.drafts.filter((d) => d.type !== "TRANSFER") ?? [],
    [parsed],
  );
  const transferCount = (parsed?.drafts.length ?? 0) - importable.length;

  const accountNames = useMemo(
    () => distinctNames(importable, (d) => [d.accountName]),
    [importable],
  );
  const categoryNames = useMemo(
    () => distinctNames(importable, (d) => [d.categoryName]),
    [importable],
  );
  const allAccountsMapped = accountNames.every((name) => accountMap[name.toLowerCase()]);

  const reset = () => {
    setParsed(null);
    setAccountMap({});
    setCategoryMap({});
    setSummary(null);
    setBusy(false);
  };

  const close = (next: boolean) => {
    if (busy) return;
    if (!next) reset();
    onOpenChange(next);
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const csv = await parseCsv(file, { hasHeaderRow: true, delimiter: "auto" });
      const result =
        kind === "expense"
          ? parseExpenseRows(csv.headers, csv.rows)
          : parseMutasiRows(csv.headers, csv.rows);
      const usable = result.drafts.filter((d) => d.type !== "TRANSFER");

      const nextAccounts: Record<string, string> = {};
      for (const name of distinctNames(usable, (d) => [d.accountName])) {
        const match = matchByName(name, cashAccounts);
        if (match) nextAccounts[name.toLowerCase()] = match.id;
      }
      const nextCategories: Record<string, string> = {};
      for (const name of distinctNames(usable, (d) => [d.categoryName])) {
        const match = categories.find(
          (c) =>
            c.name.trim().toLowerCase() === name.toLowerCase() ||
            getCategoryLabel(t, CATEGORY_TAXONOMY_ID, c.id, c.name).toLowerCase() ===
              name.toLowerCase(),
        );
        nextCategories[name.toLowerCase()] = match?.id ?? NO_CATEGORY;
      }
      setAccountMap(nextAccounts);
      setCategoryMap(nextCategories);
      setParsed(result);
    } catch {
      toast.error(t("spending:sheetImport.readError"));
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    setBusy(true);
    const result: ImportSummary = { imported: 0, duplicates: 0, failed: 0 };
    // Identical rows on one day are real (two snacks, same price), so the
    // duplicate check counts each repeat within the file separately.
    const seen = new Map<string, number>();

    for (const draft of importable) {
      const accountId = accountMap[draft.accountName.toLowerCase()];
      const account = cashAccounts.find((a) => a.id === accountId);
      if (!account) {
        result.failed += 1;
        continue;
      }
      const base = `sheet:${draft.kind}:${accountId}:${draft.type}:${draft.date}:${draft.amount}:${draft.note}`;
      const occurrence = (seen.get(base) ?? 0) + 1;
      seen.set(base, occurrence);

      try {
        const created = await createActivity({
          accountId,
          activityType: draft.type,
          activityDate: `${draft.date}T12:00:00.000Z`,
          amount: draft.amount,
          currency: account.currency,
          comment: draft.note || null,
          idempotencyKey: `${base}:${occurrence}`,
        });
        const categoryId = draft.categoryName
          ? categoryMap[draft.categoryName.toLowerCase()]
          : undefined;
        if (categoryId && categoryId !== NO_CATEGORY) {
          await assignActivityCategory(created.id, CATEGORY_TAXONOMY_ID, categoryId);
        }
        result.imported += 1;
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error).toLowerCase();
        if (message.includes("duplicate") || message.includes("already exists")) {
          result.duplicates += 1;
        } else {
          result.failed += 1;
        }
      }
    }

    invalidateSpendingCaches(qc);
    qc.invalidateQueries({ queryKey: [QueryKeys.ACTIVITIES] });
    qc.invalidateQueries({ queryKey: [QueryKeys.ACTIVITY_DATA] });
    setSummary(result);
    setBusy(false);
  };

  const renderSummary = (s: ImportSummary) => (
    <div className="space-y-1 text-sm">
      <p className="font-medium">{t("spending:sheetImport.done", { total: s.imported })}</p>
      {s.duplicates > 0 && (
        <p className="text-muted-foreground">
          {t("spending:sheetImport.duplicates", { total: s.duplicates })}
        </p>
      )}
      {s.failed > 0 && (
        <p className="text-destructive">{t("spending:sheetImport.failed", { total: s.failed })}</p>
      )}
    </div>
  );

  const renderDraftCounts = (p: SheetParseResult) => (
    <div className="space-y-1 text-sm">
      <p>{t("spending:sheetImport.ready", { total: importable.length })}</p>
      {p.skipped > 0 && (
        <p className="text-muted-foreground">
          {t("spending:sheetImport.skipped", { total: p.skipped })}
        </p>
      )}
      {transferCount > 0 && (
        <p className="text-muted-foreground">
          {t("spending:sheetImport.transfersSkipped", { total: transferCount })}
        </p>
      )}
      {p.errors.length > 0 && (
        <p className="text-destructive">
          {t("spending:sheetImport.badRows", {
            total: p.errors.length,
            rows: p.errors
              .slice(0, 5)
              .map((e: { row: number }) => e.row)
              .join(", "),
          })}
        </p>
      )}
    </div>
  );

  const renderMapping = (drafts: SheetDraft[]) => (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>{t("spending:sheetImport.accountsHeading")}</Label>
        {accountNames.map((name) => (
          <div key={name} className="flex items-center justify-between gap-3">
            <span className="text-sm">{name}</span>
            <Select
              value={accountMap[name.toLowerCase()] ?? ""}
              onValueChange={(value) =>
                setAccountMap((prev) => ({ ...prev, [name.toLowerCase()]: value ?? "" }))
              }
            >
              <SelectTrigger className="w-56">
                <SelectValue placeholder={t("spending:sheetImport.chooseAccount")}>
                  {(() => {
                    const chosen = cashAccounts.find(
                      (a) => a.id === accountMap[name.toLowerCase()],
                    );
                    return chosen ? `${chosen.name} (${chosen.currency})` : null;
                  })()}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {cashAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name} ({a.currency})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
        {cashAccounts.length === 0 && (
          <p className="text-destructive text-sm">{t("spending:sheetImport.noAccounts")}</p>
        )}
      </div>

      {categoryNames.length > 0 && drafts.length > 0 && (
        <div className="space-y-2">
          <Label>{t("spending:sheetImport.categoriesHeading")}</Label>
          {categoryNames.map((name) => (
            <div key={name} className="flex items-center justify-between gap-3">
              <span className="text-sm">{name}</span>
              <Select
                value={categoryMap[name.toLowerCase()] ?? NO_CATEGORY}
                onValueChange={(value) =>
                  setCategoryMap((prev) => ({
                    ...prev,
                    [name.toLowerCase()]: value ?? NO_CATEGORY,
                  }))
                }
              >
                <SelectTrigger className="w-56">
                  <SelectValue>
                    {(() => {
                      const chosen = categories.find(
                        (c) => c.id === categoryMap[name.toLowerCase()],
                      );
                      return chosen
                        ? getCategoryLabel(t, CATEGORY_TAXONOMY_ID, chosen.id, chosen.name)
                        : t("spending:sheetImport.noCategory");
                    })()}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CATEGORY}>
                    {t("spending:sheetImport.noCategory")}
                  </SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {getCategoryLabel(t, CATEGORY_TAXONOMY_ID, c.id, c.name)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("spending:sheetImport.title")}</DialogTitle>
          <DialogDescription>{t("spending:sheetImport.description")}</DialogDescription>
        </DialogHeader>

        {summary ? (
          renderSummary(summary)
        ) : !parsed ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t("spending:sheetImport.kindLabel")}</Label>
              <Select
                value={kind}
                onValueChange={(v) => setKind(v === "mutasi" ? "mutasi" : "expense")}
              >
                <SelectTrigger>
                  <SelectValue>
                    {kind === "expense"
                      ? t("spending:sheetImport.kindExpense")
                      : t("spending:sheetImport.kindMutasi")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="expense">{t("spending:sheetImport.kindExpense")}</SelectItem>
                  <SelectItem value="mutasi">{t("spending:sheetImport.kindMutasi")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="sheet-import-file">{t("spending:sheetImport.fileLabel")}</Label>
              <input
                id="sheet-import-file"
                type="file"
                accept=".csv,text/csv"
                disabled={busy}
                onChange={(e) => void handleFile(e.target.files?.[0])}
                className="block w-full text-sm"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {renderDraftCounts(parsed)}
            {renderMapping(importable)}
          </div>
        )}

        <DialogFooter>
          {summary ? (
            <Button onClick={() => close(false)}>{t("spending:sheetImport.close")}</Button>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={() => close(false)}>
                {t("spending:sheetImport.cancel")}
              </Button>
              {parsed && (
                <Button
                  disabled={busy || importable.length === 0 || !allAccountsMapped}
                  onClick={() => void runImport()}
                >
                  {busy
                    ? t("spending:sheetImport.importing")
                    : t("spending:sheetImport.importButton", { total: importable.length })}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
