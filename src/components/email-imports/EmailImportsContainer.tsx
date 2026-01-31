"use client";
import { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Button } from "../ui/button";
import { Mail, RefreshCw, ListFilter } from "lucide-react";
import {
  getEmailImportsList,
  type EmailImportListItem,
  type EmailImportSortField,
  type SortOrder,
} from "@/actions/email-import.actions";
import { toast } from "../ui/use-toast";
import {
  Company,
  JobLocation,
  JobSource,
  JobStatus,
  JobTitle,
} from "@/models/job.model";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { APP_CONSTANTS } from "@/lib/constants";
import Loading from "../Loading";
import EmailImportsTable from "./EmailImportsTable";
import EmailImportReview from "./EmailImportReview";
import { RecordsPerPageSelector } from "../RecordsPerPageSelector";
import { RecordsCount } from "../RecordsCount";

type EmailImportsProps = {
  statuses: JobStatus[];
  companies: Company[];
  titles: JobTitle[];
  locations: JobLocation[];
  sources: JobSource[];
};

const CLASSIFICATION_OPTIONS = [
  { value: "job_application", label: "Application Sent" },
  { value: "job_response", label: "Application Response" },
  { value: "interview", label: "Interview" },
  { value: "rejection", label: "Rejection" },
  { value: "offer", label: "Job Offer" },
  { value: "follow_up", label: "Follow-up" },
];

const STATUS_OPTIONS = [
  { value: "pending", label: "Pending Review" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "skipped", label: "Skipped" },
];

function EmailImportsContainer({
  statuses,
  companies,
  titles,
  locations,
  sources,
}: EmailImportsProps) {
  const [imports, setImports] = useState<EmailImportListItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalImports, setTotalImports] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [classificationFilter, setClassificationFilter] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [selectedImport, setSelectedImport] = useState<EmailImportListItem | null>(null);
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [reviewQueue, setReviewQueue] = useState<string[]>([]);
  const [recordsPerPage, setRecordsPerPage] = useState<number>(
    APP_CONSTANTS.RECORDS_PER_PAGE
  );
  const [sortBy, setSortBy] = useState<EmailImportSortField>("emailDate");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");

  const loadImports = useCallback(
    async (
      pageNum: number,
      status?: string,
      classification?: string,
      sort: EmailImportSortField = sortBy,
      order: SortOrder = sortOrder
    ) => {
      setLoading(true);
      const result = await getEmailImportsList(
        pageNum,
        recordsPerPage,
        status,
        classification,
        sort,
        order
      );
      if (result?.success && result?.data) {
        setImports((prev) => (pageNum === 1 ? result.data! : [...prev, ...result.data!]));
        setTotalImports(result.total || 0);
        setPage(pageNum);
      } else {
        toast({
          title: "Error",
          description: (result as { message?: string })?.message || "Failed to load email imports",
          variant: "destructive",
        });
      }
      setLoading(false);
    },
    [recordsPerPage, sortBy, sortOrder]
  );

  useEffect(() => {
    loadImports(1, statusFilter, classificationFilter);
  }, [statusFilter, classificationFilter, loadImports]);

  const handleStatusFilterChange = (value: string) => {
    setStatusFilter(value === "all" ? "" : value);
    setPage(1);
    setImports([]);
  };

  const handleClassificationFilterChange = (value: string) => {
    setClassificationFilter(value === "all" ? "" : value);
    setPage(1);
    setImports([]);
  };

  const handleRefresh = () => {
    setPage(1);
    setImports([]);
    loadImports(1, statusFilter, classificationFilter, sortBy, sortOrder);
  };

  const handleSort = (field: EmailImportSortField) => {
    const newOrder = sortBy === field && sortOrder === "desc" ? "asc" : "desc";
    setSortBy(field);
    setSortOrder(newOrder);
    setPage(1);
    setImports([]);
    loadImports(1, statusFilter, classificationFilter, field, newOrder);
  };

  const handleReview = (emailImport: EmailImportListItem, selectedIds?: string[]) => {
    setSelectedImport(emailImport);
    setReviewQueue(selectedIds || []);
    setReviewDialogOpen(true);
  };

  const handleReviewComplete = () => {
    setReviewDialogOpen(false);
    setSelectedImport(null);
    setReviewQueue([]);
    handleRefresh();
  };

  const handleReviewNext = () => {
    if (reviewQueue.length <= 1) {
      handleReviewComplete();
      return;
    }
    // Remove current from queue and move to next
    const currentId = selectedImport?.id;
    const remainingIds = reviewQueue.filter((id) => id !== currentId);
    if (remainingIds.length > 0) {
      const nextImport = imports.find((i) => i.id === remainingIds[0]);
      if (nextImport) {
        setSelectedImport(nextImport);
        setReviewQueue(remainingIds);
      } else {
        handleReviewComplete();
      }
    } else {
      handleReviewComplete();
    }
  };

  const handleLoadMore = () => {
    loadImports(page + 1, statusFilter, classificationFilter, sortBy, sortOrder);
  };

  const handleRecordsPerPageChange = (value: number) => {
    setRecordsPerPage(value);
    setPage(1);
    setImports([]);
  };

  const hasMorePages = imports.length < totalImports;

  return (
    <>
      <Card className="min-h-[85vh]">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Email Imports
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleRefresh}>
              <RefreshCw className="h-4 w-4 mr-1" />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {/* Filters */}
          <div className="flex items-center gap-4 mb-4">
            <div className="flex items-center gap-2">
              <ListFilter className="h-4 w-4 text-muted-foreground" />
              <Select
                value={statusFilter || "all"}
                onValueChange={handleStatusFilterChange}
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Filter by status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Status</SelectLabel>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectSeparator />
                    {STATUS_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <Select
              value={classificationFilter || "all"}
              onValueChange={handleClassificationFilterChange}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Filter by type" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Email Type</SelectLabel>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectSeparator />
                  {CLASSIFICATION_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <div className="ml-auto">
              <RecordsPerPageSelector
                value={recordsPerPage}
                onChange={handleRecordsPerPageChange}
              />
            </div>
          </div>

          {/* Results */}
          {loading && imports.length === 0 ? (
            <Loading />
          ) : imports.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Mail className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No email imports found</p>
              <p className="text-sm mt-2">
                {statusFilter === "pending"
                  ? "Run the email sync to import new job-related emails"
                  : "Try adjusting the filters"}
              </p>
            </div>
          ) : (
            <EmailImportsTable
              imports={imports}
              onReview={handleReview}
              onRefresh={handleRefresh}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSort={handleSort}
            />
          )}
        </CardContent>
        <CardFooter className="flex justify-between items-center">
          <RecordsCount count={imports.length} total={totalImports} label="imports" />
          {hasMorePages && (
            <Button
              variant="outline"
              onClick={handleLoadMore}
              disabled={loading}
            >
              {loading ? "Loading..." : "Load More"}
            </Button>
          )}
        </CardFooter>
      </Card>

      {/* Review Dialog */}
      <EmailImportReview
        open={reviewDialogOpen}
        onOpenChange={setReviewDialogOpen}
        emailImport={selectedImport}
        onComplete={handleReviewComplete}
        onNext={reviewQueue.length > 1 ? handleReviewNext : undefined}
        queuePosition={reviewQueue.length > 1 ? reviewQueue.indexOf(selectedImport?.id || "") + 1 : undefined}
        queueTotal={reviewQueue.length > 1 ? reviewQueue.length : undefined}
        companies={companies}
        titles={titles}
        locations={locations}
        sources={sources}
        statuses={statuses}
      />
    </>
  );
}

export default EmailImportsContainer;
