"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bookmark,
  EyeOff,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { format } from "date-fns";
import type { DiscoverSortField, SortOrder } from "@/actions/discover.actions";

type DiscoveredJob = {
  id: string;
  externalId: string;
  source: string;
  title: string;
  company: string;
  location: string;
  salary: string | null;
  url: string | null;
  description: string | null;
  postedDate: Date | string | null;
  status: string;
  createdAt: Date | string;
};

type DiscoverTableProps = {
  jobs: DiscoveredJob[];
  sortBy: DiscoverSortField;
  sortOrder: SortOrder;
  onSort: (field: DiscoverSortField) => void;
  onSave: (id: string) => void;
  onHide: (id: string) => void;
};

interface SortableHeaderProps {
  field: DiscoverSortField;
  label: string;
  currentSort: DiscoverSortField;
  sortOrder: SortOrder;
  onSort: (field: DiscoverSortField) => void;
  className?: string;
}

function SortableHeader({
  field,
  label,
  currentSort,
  sortOrder,
  onSort,
  className,
}: SortableHeaderProps) {
  const isActive = currentSort === field;
  return (
    <button
      onClick={() => onSort(field)}
      className={cn(
        "flex items-center gap-1 hover:text-foreground transition-colors",
        className
      )}
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

export default function DiscoverTable({
  jobs,
  sortBy,
  sortOrder,
  onSort,
  onSave,
  onHide,
}: DiscoverTableProps) {
  const sourceBadgeColor = (source: string) => {
    switch (source) {
      case "adzuna":
        return "bg-blue-500";
      case "jooble":
        return "bg-purple-500";
      default:
        return "";
    }
  };

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            <SortableHeader
              field="title"
              label="Title"
              currentSort={sortBy}
              sortOrder={sortOrder}
              onSort={onSort}
            />
          </TableHead>
          <TableHead>
            <SortableHeader
              field="company"
              label="Company"
              currentSort={sortBy}
              sortOrder={sortOrder}
              onSort={onSort}
            />
          </TableHead>
          <TableHead className="hidden md:table-cell">
            <SortableHeader
              field="location"
              label="Location"
              currentSort={sortBy}
              sortOrder={sortOrder}
              onSort={onSort}
            />
          </TableHead>
          <TableHead className="hidden lg:table-cell">Salary</TableHead>
          <TableHead className="hidden md:table-cell">
            <SortableHeader
              field="postedDate"
              label="Posted"
              currentSort={sortBy}
              sortOrder={sortOrder}
              onSort={onSort}
            />
          </TableHead>
          <TableHead>
            <SortableHeader
              field="source"
              label="Source"
              currentSort={sortBy}
              sortOrder={sortOrder}
              onSort={onSort}
            />
          </TableHead>
          <TableHead>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.map((job) => (
          <TableRow key={job.id}>
            <TableCell className="font-medium max-w-[250px]">
              {job.url ? (
                <a
                  href={job.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {job.title}
                </a>
              ) : (
                job.title
              )}
            </TableCell>
            <TableCell>{job.company}</TableCell>
            <TableCell className="hidden md:table-cell">
              {job.location}
            </TableCell>
            <TableCell className="hidden lg:table-cell text-sm">
              {job.salary || "—"}
            </TableCell>
            <TableCell className="hidden md:table-cell text-sm">
              {job.postedDate
                ? format(new Date(job.postedDate), "PP")
                : "—"}
            </TableCell>
            <TableCell>
              <Badge className={cn("text-xs", sourceBadgeColor(job.source))}>
                {job.source}
              </Badge>
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-1">
                {job.status !== "saved" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => onSave(job.id)}
                    title="Save to My Jobs"
                  >
                    <Bookmark className="h-3.5 w-3.5" />
                  </Button>
                )}
                {job.status !== "hidden" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => onHide(job.id)}
                    title="Hide"
                  >
                    <EyeOff className="h-3.5 w-3.5" />
                  </Button>
                )}
                {job.url && (
                  <a
                    href={job.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Button variant="ghost" size="icon" className="h-7 w-7" title="Open URL">
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  </a>
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
