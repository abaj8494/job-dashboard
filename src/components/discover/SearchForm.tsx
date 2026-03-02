"use client";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Search } from "lucide-react";

type SearchFormProps = {
  keywords: string;
  location: string;
  maxDaysOld: number;
  source: "adzuna" | "jooble" | "both";
  loading: boolean;
  onKeywordsChange: (value: string) => void;
  onLocationChange: (value: string) => void;
  onMaxDaysOldChange: (value: number) => void;
  onSourceChange: (value: "adzuna" | "jooble" | "both") => void;
  onSearch: () => void;
};

export default function SearchForm({
  keywords,
  location,
  maxDaysOld,
  source,
  loading,
  onKeywordsChange,
  onLocationChange,
  onMaxDaysOldChange,
  onSourceChange,
  onSearch,
}: SearchFormProps) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch();
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <div className="flex-1 min-w-[200px]">
        <Label htmlFor="keywords" className="text-xs mb-1">
          Keywords
        </Label>
        <Input
          id="keywords"
          placeholder="e.g. software engineer"
          value={keywords}
          onChange={(e) => onKeywordsChange(e.target.value)}
          className="h-8"
        />
      </div>
      <div className="w-[160px]">
        <Label htmlFor="location" className="text-xs mb-1">
          Location
        </Label>
        <Input
          id="location"
          placeholder="Sydney"
          value={location}
          onChange={(e) => onLocationChange(e.target.value)}
          className="h-8"
        />
      </div>
      <div className="w-[100px]">
        <Label htmlFor="maxDays" className="text-xs mb-1">
          Max Days
        </Label>
        <Input
          id="maxDays"
          type="number"
          min={1}
          max={30}
          value={maxDaysOld}
          onChange={(e) => onMaxDaysOldChange(Number(e.target.value))}
          className="h-8"
        />
      </div>
      <div className="w-[120px]">
        <Label className="text-xs mb-1">Source</Label>
        <Select value={source} onValueChange={(v) => onSourceChange(v as any)}>
          <SelectTrigger className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="both">Both</SelectItem>
            <SelectItem value="adzuna">Adzuna</SelectItem>
            <SelectItem value="jooble">Jooble</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Button type="submit" size="sm" className="h-8 gap-1" disabled={loading || !keywords.trim()}>
        <Search className="h-3.5 w-3.5" />
        {loading ? "Searching..." : "Search Jobs"}
      </Button>
    </form>
  );
}
