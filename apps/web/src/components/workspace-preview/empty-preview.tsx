import { FileText } from "lucide-react";
import { EmptyState } from "@/components/ui";

export function EmptyPreview({ title, description }: { title: string; description: string }) {
  return (
    <EmptyState title={title} description={description} icon={<FileText className="h-5 w-5" />} />
  );
}
