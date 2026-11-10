import { notFound } from "next/navigation";

import DemoClient from "./demo-client";

export default function DemoPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <DemoClient />;
}
