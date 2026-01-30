"use client";
import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Badge } from "../ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { ScrollArea } from "../ui/scroll-area";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";
import { format } from "date-fns";
import { Mail, Send, Building2, Briefcase, MapPin, CheckCircle, XCircle, SkipForward } from "lucide-react";
import {
  type EmailImportListItem,
  approveEmailImport,
  rejectEmailImport,
  skipEmailImport,
} from "@/actions/email-import.actions";
import { addCompany } from "@/actions/company.actions";
import { createJobTitle } from "@/actions/jobtitle.actions";
import { createLocation } from "@/actions/job.actions";
import { toast } from "../ui/use-toast";
import {
  Company,
  JobLocation,
  JobSource,
  JobStatus,
  JobTitle,
} from "@/models/job.model";

interface EmailImportReviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  emailImport: EmailImportListItem | null;
  onComplete: () => void;
  companies: Company[];
  titles: JobTitle[];
  locations: JobLocation[];
  sources: JobSource[];
  statuses: JobStatus[];
}

interface ExtractedData {
  company?: string | null;
  jobTitle?: string | null;
  location?: string | null;
  applicationUrl?: string | null;
  recruiterName?: string | null;
  salaryRange?: string | null;
}

function EmailImportReview({
  open,
  onOpenChange,
  emailImport,
  onComplete,
  companies,
  titles,
  locations,
  sources,
  statuses,
}: EmailImportReviewProps) {
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("details");

  // Form state
  const [companyId, setCompanyId] = useState<string>("");
  const [titleId, setTitleId] = useState<string>("");
  const [locationId, setLocationId] = useState<string>("");
  const [sourceId, setSourceId] = useState<string>("");
  const [statusId, setStatusId] = useState<string>("");
  const [jobDescription, setJobDescription] = useState("");
  const [jobUrl, setJobUrl] = useState("");
  const [applied, setApplied] = useState(false);
  const [jobType, setJobType] = useState("FT");

  // New entity creation
  const [newCompanyName, setNewCompanyName] = useState("");
  const [newTitleName, setNewTitleName] = useState("");
  const [newLocationName, setNewLocationName] = useState("");
  const [creatingCompany, setCreatingCompany] = useState(false);
  const [creatingTitle, setCreatingTitle] = useState(false);
  const [creatingLocation, setCreatingLocation] = useState(false);

  // Parse extracted data - memoize to prevent useEffect from running on every render
  const extractedData: ExtractedData = useMemo(() => {
    return emailImport?.extractedData
      ? JSON.parse(emailImport.extractedData)
      : {};
  }, [emailImport?.extractedData]);

  // Initialize form with extracted data
  useEffect(() => {
    if (emailImport && open) {
      // Try to find matching company
      const matchedCompany = companies.find(
        (c) => c.label.toLowerCase() === extractedData.company?.toLowerCase()
      );
      setCompanyId(matchedCompany?.id || "");
      setNewCompanyName(matchedCompany ? "" : extractedData.company || "");

      // Try to find matching title
      const matchedTitle = titles.find(
        (t) => t.label.toLowerCase() === extractedData.jobTitle?.toLowerCase()
      );
      setTitleId(matchedTitle?.id || "");
      setNewTitleName(matchedTitle ? "" : extractedData.jobTitle || "");

      // Try to find matching location
      const matchedLocation = locations.find(
        (l) => l.label.toLowerCase() === extractedData.location?.toLowerCase()
      );
      setLocationId(matchedLocation?.id || "");
      setNewLocationName(matchedLocation ? "" : extractedData.location || "");

      // Set defaults based on classification
      setJobUrl(extractedData.applicationUrl || "");
      setJobDescription(
        emailImport.bodyText?.substring(0, 500) ||
          `Imported from email: ${emailImport.subject}`
      );

      // Set applied based on classification
      const isApplication = ["job_application", "job_response"].includes(
        emailImport.classification
      );
      setApplied(isApplication);

      // Set status based on classification
      const statusMap: Record<string, string> = {
        job_application: "applied",
        job_response: "applied",
        interview: "interview",
        rejection: "rejected",
        offer: "offer",
      };
      const suggestedStatus = statusMap[emailImport.classification] || "draft";
      const matchedStatus = statuses.find((s) => s.value === suggestedStatus);
      setStatusId(matchedStatus?.id || statuses[0]?.id || "");

      // Reset tabs
      setActiveTab("details");
    }
  }, [emailImport, open, companies, titles, locations, statuses, extractedData]);

  const handleCreateCompany = async () => {
    if (!newCompanyName) return;
    setCreatingCompany(true);
    const result = await addCompany({
      company: newCompanyName,
    });
    if (result?.success && result?.data?.id) {
      setCompanyId(result.data.id);
      setNewCompanyName("");
      toast({ title: "Company created" });
    }
    setCreatingCompany(false);
  };

  const handleCreateTitle = async () => {
    if (!newTitleName) return;
    setCreatingTitle(true);
    const result = await createJobTitle(newTitleName);
    if (result?.id) {
      setTitleId(result.id);
      setNewTitleName("");
      toast({ title: "Job title created" });
    }
    setCreatingTitle(false);
  };

  const handleCreateLocation = async () => {
    if (!newLocationName) return;
    setCreatingLocation(true);
    const result = await createLocation(newLocationName);
    if (result?.id) {
      setLocationId(result.id);
      setNewLocationName("");
      toast({ title: "Location created" });
    }
    setCreatingLocation(false);
  };

  const handleApprove = async () => {
    if (!emailImport) return;

    // Validate required fields
    if (!companyId && !newCompanyName) {
      toast({ title: "Company is required", variant: "destructive" });
      return;
    }
    if (!titleId && !newTitleName) {
      toast({ title: "Job title is required", variant: "destructive" });
      return;
    }
    if (!statusId) {
      toast({ title: "Status is required", variant: "destructive" });
      return;
    }

    setLoading(true);

    // Create new entities if needed
    let finalCompanyId = companyId;
    let finalTitleId = titleId;
    let finalLocationId = locationId;

    if (!companyId && newCompanyName) {
      const result = await addCompany({
        company: newCompanyName,
      });
      if (result?.success && result?.data?.id) {
        finalCompanyId = result.data.id;
      } else {
        toast({ title: "Failed to create company", variant: "destructive" });
        setLoading(false);
        return;
      }
    }

    if (!titleId && newTitleName) {
      const result = await createJobTitle(newTitleName);
      if (result?.id) {
        finalTitleId = result.id;
      } else {
        toast({ title: "Failed to create job title", variant: "destructive" });
        setLoading(false);
        return;
      }
    }

    if (!locationId && newLocationName) {
      const result = await createLocation(newLocationName);
      if (result?.id) {
        finalLocationId = result.id;
      }
    }

    // Create job
    const result = await approveEmailImport(emailImport.id, {
      title: finalTitleId,
      company: finalCompanyId,
      location: finalLocationId || undefined,
      source: sourceId || undefined,
      status: statusId,
      jobDescription,
      jobUrl: jobUrl || undefined,
      applied,
      dateApplied: applied ? new Date(emailImport.emailDate) : undefined,
      jobType,
    });

    if (result?.success) {
      toast({ title: "Job created from email import" });
      onComplete();
    } else {
      toast({ title: "Error", description: (result as { message?: string })?.message || "Failed to create job", variant: "destructive" });
    }
    setLoading(false);
  };

  const handleReject = async () => {
    if (!emailImport) return;
    setLoading(true);
    const result = await rejectEmailImport(emailImport.id);
    if (result?.success) {
      toast({ title: "Email import rejected" });
      onComplete();
    } else {
      toast({ title: "Error", description: (result as { message?: string })?.message || "Failed to reject", variant: "destructive" });
    }
    setLoading(false);
  };

  const handleSkip = async () => {
    if (!emailImport) return;
    setLoading(true);
    const result = await skipEmailImport(emailImport.id);
    if (result?.success) {
      toast({ title: "Email import skipped" });
      onComplete();
    } else {
      toast({ title: "Error", description: (result as { message?: string })?.message || "Failed to skip", variant: "destructive" });
    }
    setLoading(false);
  };

  if (!emailImport) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {emailImport.isOutbound ? (
              <Send className="h-5 w-5 text-blue-600" />
            ) : (
              <Mail className="h-5 w-5 text-green-600" />
            )}
            Review Email Import
          </DialogTitle>
          <DialogDescription>
            Review the extracted information and create a job entry
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="details">Job Details</TabsTrigger>
            <TabsTrigger value="email">Email Content</TabsTrigger>
          </TabsList>

          <TabsContent value="details" className="mt-4">
            <ScrollArea className="h-[400px] pr-4">
              <div className="space-y-4">
                {/* Email Summary */}
                <div className="bg-muted p-4 rounded-lg">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="font-medium">{emailImport.subject}</p>
                      <p className="text-sm text-muted-foreground">
                        {emailImport.isOutbound ? "To: " : "From: "}
                        {emailImport.isOutbound
                          ? emailImport.toEmail
                          : emailImport.fromName || emailImport.fromEmail}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {format(new Date(emailImport.emailDate), "PPP")}
                      </p>
                    </div>
                    <Badge>{emailImport.classification.replace("_", " ")}</Badge>
                  </div>
                </div>

                <Separator />

                {/* Company */}
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <Building2 className="h-4 w-4" />
                    Company *
                  </Label>
                  <div className="flex gap-2">
                    <Select value={companyId} onValueChange={setCompanyId}>
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Select company" />
                      </SelectTrigger>
                      <SelectContent>
                        {companies.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {!companyId && (
                    <div className="flex gap-2">
                      <Input
                        placeholder="Or create new company"
                        value={newCompanyName}
                        onChange={(e) => setNewCompanyName(e.target.value)}
                      />
                      <Button
                        variant="outline"
                        onClick={handleCreateCompany}
                        disabled={!newCompanyName || creatingCompany}
                      >
                        Create
                      </Button>
                    </div>
                  )}
                </div>

                {/* Job Title */}
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <Briefcase className="h-4 w-4" />
                    Job Title *
                  </Label>
                  <Select value={titleId} onValueChange={setTitleId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select job title" />
                    </SelectTrigger>
                    <SelectContent>
                      {titles.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {!titleId && (
                    <div className="flex gap-2">
                      <Input
                        placeholder="Or create new job title"
                        value={newTitleName}
                        onChange={(e) => setNewTitleName(e.target.value)}
                      />
                      <Button
                        variant="outline"
                        onClick={handleCreateTitle}
                        disabled={!newTitleName || creatingTitle}
                      >
                        Create
                      </Button>
                    </div>
                  )}
                </div>

                {/* Location */}
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <MapPin className="h-4 w-4" />
                    Location
                  </Label>
                  <Select value={locationId} onValueChange={setLocationId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select location (optional)" />
                    </SelectTrigger>
                    <SelectContent>
                      {locations.map((l) => (
                        <SelectItem key={l.id} value={l.id}>
                          {l.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {!locationId && (
                    <div className="flex gap-2">
                      <Input
                        placeholder="Or create new location"
                        value={newLocationName}
                        onChange={(e) => setNewLocationName(e.target.value)}
                      />
                      <Button
                        variant="outline"
                        onClick={handleCreateLocation}
                        disabled={!newLocationName || creatingLocation}
                      >
                        Create
                      </Button>
                    </div>
                  )}
                </div>

                {/* Status and Source */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Status *</Label>
                    <Select value={statusId} onValueChange={setStatusId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select status" />
                      </SelectTrigger>
                      <SelectContent>
                        {statuses.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Source</Label>
                    <Select value={sourceId} onValueChange={setSourceId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select source" />
                      </SelectTrigger>
                      <SelectContent>
                        {sources.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Job Type and Applied */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Job Type</Label>
                    <Select value={jobType} onValueChange={setJobType}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="FT">Full Time</SelectItem>
                        <SelectItem value="PT">Part Time</SelectItem>
                        <SelectItem value="C">Contract</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Applied</Label>
                    <div className="flex items-center space-x-2 pt-2">
                      <Switch checked={applied} onCheckedChange={setApplied} />
                      <span className="text-sm text-muted-foreground">
                        {applied ? "Yes" : "No"}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Job URL */}
                <div className="space-y-2">
                  <Label>Job URL</Label>
                  <Input
                    placeholder="https://..."
                    value={jobUrl}
                    onChange={(e) => setJobUrl(e.target.value)}
                  />
                </div>

                {/* Description */}
                <div className="space-y-2">
                  <Label>Description</Label>
                  <Textarea
                    placeholder="Job description..."
                    value={jobDescription}
                    onChange={(e) => setJobDescription(e.target.value)}
                    rows={4}
                  />
                </div>
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="email" className="mt-4">
            <ScrollArea className="h-[400px]">
              <div className="space-y-4 pr-4">
                <div className="bg-muted p-4 rounded-lg">
                  <p className="font-medium mb-2 break-words">{emailImport.subject}</p>
                  <div className="text-sm text-muted-foreground space-y-1">
                    <p className="break-all">From: {emailImport.fromName || emailImport.fromEmail}</p>
                    <p className="break-all">To: {emailImport.toEmail}</p>
                    <p>Date: {format(new Date(emailImport.emailDate), "PPPp")}</p>
                  </div>
                </div>
                <Separator />
                <div className="whitespace-pre-wrap text-sm break-words overflow-hidden">
                  {emailImport.bodyText || "(No text content)"}
                </div>
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>

        <DialogFooter className="flex justify-between sm:justify-between">
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleSkip}
              disabled={loading || emailImport.status !== "pending"}
            >
              <SkipForward className="h-4 w-4 mr-1" />
              Skip
            </Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={loading || emailImport.status !== "pending"}
            >
              <XCircle className="h-4 w-4 mr-1" />
              Reject
            </Button>
          </div>
          <Button
            onClick={handleApprove}
            disabled={loading || emailImport.status !== "pending"}
          >
            <CheckCircle className="h-4 w-4 mr-1" />
            {loading ? "Creating..." : "Create Job"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default EmailImportReview;
