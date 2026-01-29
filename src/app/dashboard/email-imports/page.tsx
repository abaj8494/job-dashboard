import { Metadata } from "next";
import { getJobSourceList, getStatusList } from "@/actions/job.actions";
import { getAllCompanies } from "@/actions/company.actions";
import { getAllJobTitles } from "@/actions/jobtitle.actions";
import { getAllJobLocations } from "@/actions/jobLocation.actions";
import EmailImportsContainer from "@/components/email-imports/EmailImportsContainer";

export const metadata: Metadata = {
  title: "Email Imports | JobSync",
};

async function EmailImportsPage() {
  const [statuses, companies, titles, locations, sources] = await Promise.all([
    getStatusList(),
    getAllCompanies(),
    getAllJobTitles(),
    getAllJobLocations(),
    getJobSourceList(),
  ]);

  return (
    <div className="col-span-3">
      <EmailImportsContainer
        companies={companies}
        titles={titles}
        locations={locations}
        sources={sources}
        statuses={statuses}
      />
    </div>
  );
}

export default EmailImportsPage;
