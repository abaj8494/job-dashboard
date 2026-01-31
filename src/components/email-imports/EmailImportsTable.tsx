"use client";
import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Checkbox } from "../ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  Eye,
  MoreHorizontal,
  Trash2,
  XCircle,
  SkipForward,
  Mail,
  Send,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  RotateCcw,
} from "lucide-react";
import { format } from "date-fns";
import {
  type EmailImportListItem,
  type EmailImportSortField,
  type SortOrder,
} from "@/actions/email-import.actions";
import {
  rejectEmailImport,
  skipEmailImport,
  deleteEmailImport,
  bulkRejectEmailImports,
  bulkSkipEmailImports,
  restoreToPending,
} from "@/actions/email-import.actions";
import { toast } from "../ui/use-toast";

interface EmailImportsTableProps {
  imports: EmailImportListItem[];
  onReview: (emailImport: EmailImportListItem) => void;
  onRefresh: () => void;
  sortBy: EmailImportSortField;
  sortOrder: SortOrder;
  onSort: (field: EmailImportSortField) => void;
}

interface SortableHeaderProps {
  field: EmailImportSortField;
  label: string;
  currentSort: EmailImportSortField;
  sortOrder: SortOrder;
  onSort: (field: EmailImportSortField) => void;
}

function SortableHeader({ field, label, currentSort, sortOrder, onSort }: SortableHeaderProps) {
  const isActive = currentSort === field;
  return (
    <button
      onClick={() => onSort(field)}
      className="flex items-center gap-1 hover:text-foreground transition-colors"
    >
      {label}
      {isActive ? (
        sortOrder === "asc" ? (
          <ArrowUp className="h-3 w-3" />
        ) : (
          <ArrowDown className="h-3 w-3" />
        )
      ) : (
        <ArrowUpDown className="h-3 w-3 opacity-50" />
      )}
    </button>
  );
}

const CLASSIFICATION_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  job_application: { label: "Application Sent", variant: "default" },
  job_response: { label: "Response", variant: "secondary" },
  interview: { label: "Interview", variant: "default" },
  rejection: { label: "Rejection", variant: "destructive" },
  offer: { label: "Offer", variant: "default" },
  follow_up: { label: "Follow-up", variant: "outline" },
  other: { label: "Other", variant: "outline" },
};

const STATUS_BADGES: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "Pending", variant: "outline" },
  approved: { label: "Approved", variant: "default" },
  rejected: { label: "Rejected", variant: "destructive" },
  skipped: { label: "Skipped", variant: "secondary" },
};

function EmailImportsTable({ imports, onReview, onRefresh, sortBy, sortOrder, onSort }: EmailImportsTableProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      const pendingIds = imports
        .filter((i) => i.status === "pending")
        .map((i) => i.id);
      setSelectedIds(new Set(pendingIds));
    } else {
      setSelectedIds(new Set());
    }
  };

  const handleSelectOne = (id: string, checked: boolean) => {
    const newSet = new Set(selectedIds);
    if (checked) {
      newSet.add(id);
    } else {
      newSet.delete(id);
    }
    setSelectedIds(newSet);
  };

  const handleReject = async (id: string) => {
    setLoading(true);
    const result = await rejectEmailImport(id);
    if (result?.success) {
      toast({ title: "Email import rejected" });
      onRefresh();
    } else {
      toast({ title: "Error", description: (result as { message?: string })?.message || "Failed", variant: "destructive" });
    }
    setLoading(false);
  };

  const handleSkip = async (id: string) => {
    setLoading(true);
    const result = await skipEmailImport(id);
    if (result?.success) {
      toast({ title: "Email import skipped" });
      onRefresh();
    } else {
      toast({ title: "Error", description: (result as { message?: string })?.message || "Failed", variant: "destructive" });
    }
    setLoading(false);
  };

  const handleDelete = async (id: string) => {
    setLoading(true);
    const result = await deleteEmailImport(id);
    if (result?.success) {
      toast({ title: "Email import deleted" });
      onRefresh();
    } else {
      toast({ title: "Error", description: (result as { message?: string })?.message || "Failed", variant: "destructive" });
    }
    setLoading(false);
  };

  const handleRestore = async (id: string) => {
    setLoading(true);
    const result = await restoreToPending(id);
    if (result?.success) {
      toast({ title: "Email import restored to pending" });
      onRefresh();
    } else {
      toast({ title: "Error", description: (result as { message?: string })?.message || "Failed", variant: "destructive" });
    }
    setLoading(false);
  };

  const handleBulkReject = async () => {
    if (selectedIds.size === 0) return;
    setLoading(true);
    const result = await bulkRejectEmailImports(Array.from(selectedIds));
    if (result?.success) {
      toast({ title: `${selectedIds.size} imports rejected` });
      setSelectedIds(new Set());
      onRefresh();
    } else {
      toast({ title: "Error", description: (result as { message?: string })?.message || "Failed", variant: "destructive" });
    }
    setLoading(false);
  };

  const handleBulkSkip = async () => {
    if (selectedIds.size === 0) return;
    setLoading(true);
    const result = await bulkSkipEmailImports(Array.from(selectedIds));
    if (result?.success) {
      toast({ title: `${selectedIds.size} imports skipped` });
      setSelectedIds(new Set());
      onRefresh();
    } else {
      toast({ title: "Error", description: (result as { message?: string })?.message || "Failed", variant: "destructive" });
    }
    setLoading(false);
  };

  const pendingImports = imports.filter((i) => i.status === "pending");
  const allPendingSelected = pendingImports.length > 0 && pendingImports.every((i) => selectedIds.has(i.id));

  return (
    <div>
      {/* Bulk Actions */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 mb-4 p-2 bg-muted rounded-md">
          <span className="text-sm text-muted-foreground">
            {selectedIds.size} selected
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={handleBulkSkip}
            disabled={loading}
          >
            <SkipForward className="h-4 w-4 mr-1" />
            Skip All
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleBulkReject}
            disabled={loading}
          >
            <XCircle className="h-4 w-4 mr-1" />
            Reject All
          </Button>
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">
              <Checkbox
                checked={allPendingSelected}
                onCheckedChange={handleSelectAll}
                disabled={pendingImports.length === 0}
              />
            </TableHead>
            <TableHead>
              <SortableHeader field="emailDate" label="Date" currentSort={sortBy} sortOrder={sortOrder} onSort={onSort} />
            </TableHead>
            <TableHead>Direction</TableHead>
            <TableHead>
              <SortableHeader field="fromEmail" label="From / To" currentSort={sortBy} sortOrder={sortOrder} onSort={onSort} />
            </TableHead>
            <TableHead>
              <SortableHeader field="subject" label="Subject" currentSort={sortBy} sortOrder={sortOrder} onSort={onSort} />
            </TableHead>
            <TableHead>
              <SortableHeader field="classification" label="Type" currentSort={sortBy} sortOrder={sortOrder} onSort={onSort} />
            </TableHead>
            <TableHead>
              <SortableHeader field="confidence" label="Confidence" currentSort={sortBy} sortOrder={sortOrder} onSort={onSort} />
            </TableHead>
            <TableHead>
              <SortableHeader field="status" label="Status" currentSort={sortBy} sortOrder={sortOrder} onSort={onSort} />
            </TableHead>
            <TableHead className="w-12"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {imports.map((emailImport) => {
            const classificationInfo = CLASSIFICATION_LABELS[emailImport.classification] || CLASSIFICATION_LABELS.other;
            const statusInfo = STATUS_BADGES[emailImport.status] || STATUS_BADGES.pending;

            return (
              <TableRow key={emailImport.id}>
                <TableCell>
                  <Checkbox
                    checked={selectedIds.has(emailImport.id)}
                    onCheckedChange={(checked: boolean) =>
                      handleSelectOne(emailImport.id, checked)
                    }
                    disabled={emailImport.status !== "pending"}
                  />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {format(new Date(emailImport.emailDate), "MMM d, yyyy")}
                </TableCell>
                <TableCell>
                  {emailImport.isOutbound ? (
                    <span className="flex items-center gap-1 text-blue-600">
                      <Send className="h-3 w-3" />
                      Sent
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-green-600">
                      <Mail className="h-3 w-3" />
                      Received
                    </span>
                  )}
                </TableCell>
                <TableCell className="max-w-[200px] truncate">
                  {emailImport.isOutbound ? emailImport.toEmail : emailImport.fromEmail}
                </TableCell>
                <TableCell className="max-w-[300px] truncate">
                  {emailImport.subject}
                </TableCell>
                <TableCell>
                  <Badge variant={classificationInfo.variant}>
                    {classificationInfo.label}
                  </Badge>
                </TableCell>
                <TableCell>
                  <span className={`text-sm ${emailImport.confidence >= 0.8 ? "text-green-600" : emailImport.confidence >= 0.6 ? "text-yellow-600" : "text-red-600"}`}>
                    {(emailImport.confidence * 100).toFixed(0)}%
                  </span>
                </TableCell>
                <TableCell>
                  <Badge variant={statusInfo.variant}>
                    {statusInfo.label}
                  </Badge>
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onReview(emailImport)}>
                        <Eye className="h-4 w-4 mr-2" />
                        Review
                      </DropdownMenuItem>
                      {emailImport.status === "pending" && (
                        <>
                          <DropdownMenuItem onClick={() => handleSkip(emailImport.id)}>
                            <SkipForward className="h-4 w-4 mr-2" />
                            Skip
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleReject(emailImport.id)}>
                            <XCircle className="h-4 w-4 mr-2" />
                            Reject
                          </DropdownMenuItem>
                        </>
                      )}
                      {(emailImport.status === "rejected" || emailImport.status === "skipped") && (
                        <DropdownMenuItem onClick={() => handleRestore(emailImport.id)}>
                          <RotateCcw className="h-4 w-4 mr-2" />
                          Restore to Pending
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onClick={() => handleDelete(emailImport.id)}
                        className="text-destructive"
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export default EmailImportsTable;
