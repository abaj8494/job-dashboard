import { Metadata } from "next";
import DiscoverContainer from "@/components/discover/DiscoverContainer";

export const metadata: Metadata = {
  title: "Discover Jobs | JobSync",
};

export default function DiscoverPage() {
  return (
    <div className="col-span-3">
      <DiscoverContainer />
    </div>
  );
}
