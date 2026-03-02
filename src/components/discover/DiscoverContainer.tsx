"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ListFilter, Search } from "lucide-react";
import {
  getDiscoveredJobs,
  searchAndStoreJobs,
  updateDiscoveredJobStatus,
  saveToMyJobs,
  type DiscoverSortField,
  type SortOrder,
} from "@/actions/discover.actions";
import { toast } from "../ui/use-toast";
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
import SearchForm from "./SearchForm";
import DiscoverTable from "./DiscoverTable";
import { RecordsPerPageSelector } from "../RecordsPerPageSelector";
import { RecordsCount } from "../RecordsCount";

export default function DiscoverContainer() {
  const [jobs, setJobs] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [totalJobs, setTotalJobs] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("new");
  const [recordsPerPage, setRecordsPerPage] = useState<number>(
    APP_CONSTANTS.RECORDS_PER_PAGE
  );
  const [sortBy, setSortBy] = useState<DiscoverSortField>("createdAt");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");

  // Search form state
  const [keywords, setKeywords] = useState("");
  const [location, setLocation] = useState("Sydney");
  const [maxDaysOld, setMaxDaysOld] = useState(3);
  const [source, setSource] = useState<"adzuna" | "jooble" | "both">("both");

  const hasSearched = useRef(false);

  const loadJobs = useCallback(
    async (
      p: number,
      filter?: string,
      search?: string,
      sort?: DiscoverSortField,
      order?: SortOrder
    ) => {
      setLoading(true);
      const result = await getDiscoveredJobs(
        p,
        recordsPerPage,
        filter,
        search,
        sort || sortBy,
        order || sortOrder
      );
      if (result.success && result.data) {
        setJobs((prev) => (p === 1 ? result.data : [...prev, ...result.data]));
        setTotalJobs(result.total!);
        setPage(p);
      } else {
        toast({
          variant: "destructive",
          title: "Error!",
          description: (result as any).message || "Failed to load jobs",
        });
      }
      setLoading(false);
    },
    [recordsPerPage, sortBy, sortOrder]
  );

  const handleSearch = async () => {
    if (!keywords.trim()) return;
    setSearching(true);
    const result = await searchAndStoreJobs({
      keywords,
      location,
      maxDaysOld,
      source,
    });
    if (result.success) {
      toast({
        variant: "success",
        description: `Found and stored ${(result as any).count} jobs`,
      });
      await loadJobs(1, statusFilter, searchTerm || undefined);
    } else {
      toast({
        variant: "destructive",
        title: "Error!",
        description: (result as any).message || "Search failed",
      });
    }
    setSearching(false);
  };

  const handleSort = (field: DiscoverSortField) => {
    const newOrder =
      sortBy === field && sortOrder === "desc" ? "asc" : "desc";
    setSortBy(field);
    setSortOrder(newOrder);
    loadJobs(1, statusFilter, searchTerm || undefined, field, newOrder);
  };

  const handleSave = async (id: string) => {
    const result = await saveToMyJobs(id);
    if (result.success) {
      toast({
        variant: "success",
        description: "Job saved to My Jobs",
      });
      await loadJobs(1, statusFilter, searchTerm || undefined);
    } else {
      toast({
        variant: "destructive",
        title: "Error!",
        description: (result as any).message || "Failed to save job",
      });
    }
  };

  const handleHide = async (id: string) => {
    const result = await updateDiscoveredJobStatus(id, "hidden");
    if (result.success) {
      setJobs((prev) => prev.filter((j) => j.id !== id));
      setTotalJobs((prev) => prev - 1);
    } else {
      toast({
        variant: "destructive",
        title: "Error!",
        description: (result as any).message || "Failed to hide job",
      });
    }
  };

  const onFilterChange = (value: string) => {
    const filter = value === "all" ? undefined : value;
    setStatusFilter(value);
    loadJobs(1, filter, searchTerm || undefined);
  };

  useEffect(() => {
    loadJobs(1, statusFilter, undefined);
  }, [loadJobs, statusFilter]);

  useEffect(() => {
    if (searchTerm !== "") {
      hasSearched.current = true;
    }
    if (searchTerm === "" && !hasSearched.current) return;

    const timer = setTimeout(() => {
      const filter = statusFilter === "all" ? undefined : statusFilter;
      loadJobs(1, filter, searchTerm || undefined);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Discover Jobs</CardTitle>
        <SearchForm
          keywords={keywords}
          location={location}
          maxDaysOld={maxDaysOld}
          source={source}
          loading={searching}
          onKeywordsChange={setKeywords}
          onLocationChange={setLocation}
          onMaxDaysOldChange={setMaxDaysOld}
          onSourceChange={setSource}
          onSearch={handleSearch}
        />
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2 mb-4">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Filter results..."
              className="pl-8 h-8 w-[150px] lg:w-[200px]"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <Select value={statusFilter} onValueChange={onFilterChange}>
            <SelectTrigger className="w-[120px] h-8">
              <ListFilter className="h-3.5 w-3.5" />
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Filter by status</SelectLabel>
                <SelectSeparator />
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="new">New</SelectItem>
                <SelectItem value="saved">Saved</SelectItem>
                <SelectItem value="hidden">Hidden</SelectItem>
                <SelectItem value="applied">Applied</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        {(loading || searching) && <Loading />}

        {jobs.length > 0 && (
          <>
            <DiscoverTable
              jobs={jobs}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSort={handleSort}
              onSave={handleSave}
              onHide={handleHide}
            />
            <div className="flex items-center justify-between mt-4">
              <RecordsCount
                count={jobs.length}
                total={totalJobs}
                label="jobs"
              />
              {totalJobs > APP_CONSTANTS.RECORDS_PER_PAGE && (
                <RecordsPerPageSelector
                  value={recordsPerPage}
                  onChange={setRecordsPerPage}
                />
              )}
            </div>
          </>
        )}

        {!loading && !searching && jobs.length === 0 && (
          <div className="text-center text-muted-foreground py-8">
            No jobs found. Use the search form above to discover new opportunities.
          </div>
        )}

        {jobs.length < totalJobs && (
          <div className="flex justify-center p-4">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const filter = statusFilter === "all" ? undefined : statusFilter;
                loadJobs(page + 1, filter, searchTerm || undefined);
              }}
              disabled={loading}
            >
              {loading ? "Loading..." : "Load More"}
            </Button>
          </div>
        )}
      </CardContent>
      <CardFooter />
    </Card>
  );
}
