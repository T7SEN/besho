// src/components/ui/rich-text-editor.tsx
"use client";

import React, {
  forwardRef,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  SquareCode,
  Strikethrough,
} from "lucide-react";
import { MarkdownRenderer } from "./markdown-renderer";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn, isArabic } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";

export interface RichTextEditorProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  minHeight?: string;
  /** Hide the markdown formatting toolbar. Default: shown. Useful for
   *  surfaces where vertical space is at a premium and the user
   *  doesn't need formatting (e.g. inline reply boxes). */
  hideToolbar?: boolean;
}

// ─── Toolbar action helpers ──────────────────────────────────────────────────
//
// All transforms are pure: they take (value, selectionStart, selectionEnd)
// and return { value, selectionStart, selectionEnd } describing the new
// state. Caller is responsible for applying the value to the textarea
// and restoring the caret.

interface SelectionState {
  value: string;
  start: number;
  end: number;
}

/** Wrap the selection with `prefix` ... `suffix`. Suffix defaults to
 *  the prefix (symmetric pairs like `**` ... `**`). When the selection
 *  is empty, places the caret between the markers so the user can
 *  type immediately. */
function wrapSelection(
  state: SelectionState,
  prefix: string,
  suffix: string = prefix,
): SelectionState {
  const { value, start, end } = state;
  const before = value.slice(0, start);
  const selected = value.slice(start, end);
  const after = value.slice(end);
  const newValue = `${before}${prefix}${selected}${suffix}${after}`;
  if (selected.length === 0) {
    // Caret between markers.
    const caret = start + prefix.length;
    return { value: newValue, start: caret, end: caret };
  }
  return {
    value: newValue,
    start: start + prefix.length,
    end: end + prefix.length,
  };
}

/** Add `prefix` to the start of every line touching the selection.
 *  If selection is empty, prefixes the line containing the caret.
 *  The renumber callback (when supplied) gets `(prefix, lineIndex)`
 *  and returns the actual prefix for that line — used by ordered
 *  lists to produce `1. `, `2. `, `3. ` etc. */
function prependLines(
  state: SelectionState,
  prefix: string,
  renumber?: (lineIndex: number) => string,
): SelectionState {
  const { value, start, end } = state;
  // Expand to full-line boundaries.
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const lineEndRaw = value.indexOf("\n", end);
  const lineEnd = lineEndRaw === -1 ? value.length : lineEndRaw;

  const selected = value.slice(lineStart, lineEnd);
  const lines = selected.split("\n");
  const transformed = lines
    .map((line, i) => `${renumber ? renumber(i) : prefix}${line}`)
    .join("\n");
  const before = value.slice(0, lineStart);
  const after = value.slice(lineEnd);
  const newValue = `${before}${transformed}${after}`;
  // Move the selection to cover the newly-prefixed range.
  const newStart = lineStart;
  const newEnd = lineStart + transformed.length;
  return { value: newValue, start: newStart, end: newEnd };
}

/** Wraps the selection in a fenced code block. Adds leading/trailing
 *  newlines so the block stands apart from surrounding text. */
function wrapCodeBlock(state: SelectionState): SelectionState {
  const { value, start, end } = state;
  const before = value.slice(0, start);
  const selected = value.slice(start, end);
  const after = value.slice(end);
  // Pad with a blank line above/below if the surrounding context isn't
  // already at a paragraph break.
  const leadPad = before.length === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "" : "\n";
  const tailPad = after.length === 0 || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "" : "\n";
  const opener = `${leadPad}\`\`\`\n`;
  const closer = `\n\`\`\`${tailPad}`;
  const newValue = `${before}${opener}${selected}${closer}${after}`;
  if (selected.length === 0) {
    // Drop the caret on the blank line between the fences.
    const caret = start + opener.length;
    return { value: newValue, start: caret, end: caret };
  }
  return {
    value: newValue,
    start: start + opener.length,
    end: end + opener.length,
  };
}

/** `[text](url)` link insertion. Selection becomes link text; caret
 *  lands inside the URL placeholder so the user can paste / type the
 *  destination. */
function insertLink(state: SelectionState): SelectionState {
  const { value, start, end } = state;
  const before = value.slice(0, start);
  const selected = value.slice(start, end);
  const after = value.slice(end);
  const text = selected.length > 0 ? selected : "text";
  const placeholder = "url";
  const inserted = `[${text}](${placeholder})`;
  const newValue = `${before}${inserted}${after}`;
  // Select the URL placeholder so the user can overwrite it directly.
  const urlStart = before.length + text.length + 3; // [text]( ← here
  const urlEnd = urlStart + placeholder.length;
  return { value: newValue, start: urlStart, end: urlEnd };
}

/** Insert a horizontal rule on its own line. */
function insertHorizontalRule(state: SelectionState): SelectionState {
  const { value, start, end } = state;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before.length === 0 || before.endsWith("\n") ? "" : "\n";
  const tail = after.startsWith("\n") || after.length === 0 ? "" : "\n";
  const inserted = `${lead}---\n${tail}`;
  const newValue = `${before}${inserted}${after}`;
  const caret = before.length + inserted.length;
  return { value: newValue, start: caret, end: caret };
}

/** Trigger React's onChange via the native input event. Setting
 *  `textarea.value = ...` directly bypasses React's tracked-value
 *  comparison and the onChange never fires. The official workaround
 *  is to call the setter from `HTMLTextAreaElement.prototype` then
 *  dispatch a bubbling input event — React's event system picks it
 *  up like a real keystroke. */
function dispatchNativeValue(
  textarea: HTMLTextAreaElement,
  value: string,
): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (!setter) return;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

// ─── Toolbar UI ──────────────────────────────────────────────────────────────

interface ToolbarAction {
  /** Stable id for the React key. */
  id: string;
  /** Hover / a11y label. */
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  apply: (state: SelectionState) => SelectionState;
}

interface ToolbarGroup {
  id: string;
  actions: ToolbarAction[];
}

const TOOLBAR_GROUPS: readonly ToolbarGroup[] = [
  {
    id: "inline",
    actions: [
      {
        id: "bold",
        label: "Bold (** **)",
        Icon: Bold,
        apply: (s) => wrapSelection(s, "**"),
      },
      {
        id: "italic",
        label: "Italic (* *)",
        Icon: Italic,
        apply: (s) => wrapSelection(s, "*"),
      },
      {
        id: "strike",
        label: "Strikethrough (~~ ~~)",
        Icon: Strikethrough,
        apply: (s) => wrapSelection(s, "~~"),
      },
      {
        id: "code",
        label: "Inline code (` `)",
        Icon: Code,
        apply: (s) => wrapSelection(s, "`"),
      },
    ],
  },
  {
    id: "headings",
    actions: [
      {
        id: "h1",
        label: "Heading 1 (#)",
        Icon: Heading1,
        apply: (s) => prependLines(s, "# "),
      },
      {
        id: "h2",
        label: "Heading 2 (##)",
        Icon: Heading2,
        apply: (s) => prependLines(s, "## "),
      },
      {
        id: "h3",
        label: "Heading 3 (###)",
        Icon: Heading3,
        apply: (s) => prependLines(s, "### "),
      },
    ],
  },
  {
    id: "lists",
    actions: [
      {
        id: "bullet",
        label: "Bullet list (- )",
        Icon: List,
        apply: (s) => prependLines(s, "- "),
      },
      {
        id: "ordered",
        label: "Ordered list (1. 2. 3.)",
        Icon: ListOrdered,
        // Renumber per line so multi-line selections produce a real
        // sequence. `remark-gfm` still tolerates `1. ` for every line
        // (it auto-renumbers on render), but explicit numbers are the
        // friendlier authoring path.
        apply: (s) => prependLines(s, "1. ", (i) => `${i + 1}. `),
      },
      {
        id: "task",
        label: "Task list (- [ ])",
        Icon: ListChecks,
        apply: (s) => prependLines(s, "- [ ] "),
      },
    ],
  },
  {
    id: "blocks",
    actions: [
      {
        id: "quote",
        label: "Blockquote (>)",
        Icon: Quote,
        apply: (s) => prependLines(s, "> "),
      },
      {
        id: "codeblock",
        label: "Code block (``` ```)",
        Icon: SquareCode,
        apply: wrapCodeBlock,
      },
      {
        id: "link",
        label: "Link [text](url)",
        Icon: Link2,
        apply: insertLink,
      },
      {
        id: "hr",
        label: "Horizontal rule (---)",
        Icon: Minus,
        apply: insertHorizontalRule,
      },
    ],
  },
];

interface MarkdownToolbarProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
}

function MarkdownToolbar({ textareaRef, disabled }: MarkdownToolbarProps) {
  const handleAction = useCallback(
    (action: ToolbarAction) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const next = action.apply({
        value: ta.value,
        start: ta.selectionStart ?? ta.value.length,
        end: ta.selectionEnd ?? ta.value.length,
      });
      dispatchNativeValue(ta, next.value);
      // Defer the selection restore — React commits the new value on
      // the next tick (the dispatched input event triggers onChange,
      // which updates either `internalValue` here or controlled state
      // upstream). § 4 deferred-setState pattern, applied to the DOM
      // selection-restore path.
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(next.start, next.end);
        }
      }, 0);
      void vibrate(15, "light");
    },
    [textareaRef],
  );

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1 rounded-md border border-white/5 bg-black/20 p-1",
        disabled && "opacity-50",
      )}
      role="toolbar"
      aria-label="Markdown formatting"
    >
      {TOOLBAR_GROUPS.map((group, idx) => (
        <React.Fragment key={group.id}>
          {idx > 0 && (
            <span
              aria-hidden="true"
              className="mx-0.5 h-5 w-px shrink-0 bg-white/10"
            />
          )}
          {group.actions.map((action) => {
            const Icon = action.Icon;
            return (
              <button
                key={action.id}
                type="button"
                title={action.label}
                aria-label={action.label}
                disabled={disabled}
                // Prevent the button from stealing focus from the
                // textarea on tap — preserves the selection so the
                // transform reads the user's intended range.
                onMouseDown={(e) => e.preventDefault()}
                onTouchStart={(e) => e.stopPropagation()}
                onClick={() => handleAction(action)}
                className={cn(
                  "inline-flex h-7 w-7 items-center justify-center rounded",
                  "text-muted-foreground/70 transition-colors",
                  "hover:bg-white/5 hover:text-foreground",
                  "active:scale-[0.95]",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            );
          })}
        </React.Fragment>
      ))}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

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
      hideToolbar,
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

    // Internal ref for the toolbar; merge with the consumer's ref so
    // callers that pass their own `ref` still get the textarea node.
    const internalRef = useRef<HTMLTextAreaElement | null>(null);
    const setRefs = useCallback(
      (node: HTMLTextAreaElement | null) => {
        internalRef.current = node;
        if (typeof ref === "function") {
          ref(node);
        } else if (ref) {
          // ref objects are mutable here despite the readonly type.
          (
            ref as React.MutableRefObject<HTMLTextAreaElement | null>
          ).current = node;
        }
      },
      [ref],
    );

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

    // Memoize the toolbar so the React tree doesn't churn on every
    // keystroke (the toolbar's only dependency is the ref + disabled).
    const toolbar = useMemo(() => {
      if (hideToolbar) return null;
      return (
        <MarkdownToolbar textareaRef={internalRef} disabled={disabled} />
      );
    }, [hideToolbar, disabled]);

    return (
      <div className={cn("flex w-full flex-col gap-2", className)}>
        <Tabs
          defaultValue="write"
          className="w-full"
          onValueChange={() => void vibrate(20, "light")}
        >
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="write" disabled={disabled}>
              Write
            </TabsTrigger>
            <TabsTrigger value="preview" disabled={disabled}>
              Preview
            </TabsTrigger>
          </TabsList>

          {/* `forceMount` keeps the textarea in the DOM so its value is
              captured by FormData even when the user submits while
              Preview is active (per AGENTS.md § 4). Without
              `data-[state=inactive]:hidden`, Radix renders the Write
              content visibly alongside Preview — `forceMount` doesn't
              auto-hide. CSS `display:none` does NOT remove named inputs
              from form serialization, so FormData still picks up the
              value. */}
          <TabsContent
            value="write"
            className="mt-0 flex flex-col gap-2 pt-2 data-[state=inactive]:hidden"
            forceMount
          >
            {toolbar}
            <Textarea
              ref={setRefs}
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
