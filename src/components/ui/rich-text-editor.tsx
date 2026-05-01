// src/components/ui/rich-text-editor.tsx
"use client";

import React, { forwardRef, useCallback, useState } from "react";
import { MarkdownRenderer } from "./markdown-renderer";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn, isArabic } from "@/lib/utils";

export interface RichTextEditorProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  minHeight?: string;
}

export const RichTextEditor = forwardRef<
  HTMLTextAreaElement,
  RichTextEditorProps
>(
  (
    {
      value,
      defaultValue = "",
      onChange,
      placeholder = "Enter details here...",
      className,
      minHeight = "min-h-[150px]",
      disabled,
      ...props
    },
    ref,
  ) => {
    const [internalValue, setInternalValue] = useState(
      typeof defaultValue === "string" ? defaultValue : "",
    );

    const isControlled = value !== undefined;
    const currentValue = isControlled ? String(value) : internalValue;
    const hasArabicText = isArabic(currentValue);

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newValue = e.target.value;

        if (!isControlled) {
          setInternalValue(newValue);
        }

        if (onChange) {
          onChange(e);
        }
      },
      [isControlled, onChange],
    );

    return (
      <div className={cn("flex w-full flex-col gap-2", className)}>
        <Tabs defaultValue="write" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="write" disabled={disabled}>
              Write
            </TabsTrigger>
            <TabsTrigger value="preview" disabled={disabled}>
              Preview
            </TabsTrigger>
          </TabsList>

          <TabsContent value="write" className="mt-0 pt-2">
            <Textarea
              ref={ref}
              disabled={disabled}
              dir="auto"
              value={currentValue}
              onChange={handleChange}
              placeholder={placeholder}
              className={cn(
                "resize-y whitespace-pre-wrap text-start p-3",
                hasArabicText ? "font-arabic leading-loose" : "font-sans",
                minHeight,
              )}
              {...props}
            />
          </TabsContent>

          <TabsContent value="preview" className="mt-0 pt-2">
            <div
              className={cn(
                "w-full overflow-y-auto rounded-md border p-3",
                disabled ? "cursor-not-allowed opacity-50" : "bg-muted/20",
                minHeight,
              )}
            >
              {currentValue.trim() !== "" ? (
                <MarkdownRenderer content={currentValue} />
              ) : (
                <span className="text-sm italic text-muted-foreground">
                  Nothing to preview yet...
                </span>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>
    );
  },
);

RichTextEditor.displayName = "RichTextEditor";
