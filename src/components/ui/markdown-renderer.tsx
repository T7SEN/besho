// src/components/ui/markdown-renderer.tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { cn, isArabic } from "@/lib/utils";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

function preserveNewlines(text: string) {
  const normalizedText = text.replace(/\r\n/g, "\n");
  return normalizedText.replace(/\n(?=\n)/g, "\n\u200B");
}

export function MarkdownRenderer({
  content,
  className,
}: MarkdownRendererProps) {
  // Determine typography dynamically based on content
  const hasArabicText = isArabic(content);

  return (
    <div
      dir="auto"
      className={cn(
        "prose prose-sm dark:prose-invert max-w-none wrap-break-word text-start",
        "prose-p:leading-relaxed prose-pre:p-0",
        hasArabicText ? "font-arabic leading-loose" : "font-sans",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
        {preserveNewlines(content)}
      </ReactMarkdown>
    </div>
  );
}
