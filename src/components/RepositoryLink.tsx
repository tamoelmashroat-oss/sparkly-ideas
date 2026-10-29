import { Github } from "lucide-react";
import { Button } from "@/components/ui/button";

export function RepositoryLink() {
  const repository = import.meta.env['VITE_CODE_REPOSITORY'] as string | undefined;
  if (!repository) return null;
  return (
    <Button asChild variant="ghost" size="icon" className="shrink-0" aria-label="فتح المستودع على GitHub">
      <a href={`https://github.com/${repository}`} target="_blank" rel="noopener noreferrer" title={`GitHub: ${repository}`}>
        <Github className="h-4 w-4" />
      </a>
    </Button>
  );
}