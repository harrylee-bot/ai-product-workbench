"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import type {
  CreateDesignSystemRequest,
  DesignPresetCatalogItem,
  DesignSystemCatalogItem,
  RunDesignStyle,
} from "@workbench/workbench-contracts";
import { CheckCircle2Icon, FileTextIcon, PaletteIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { motion } from "framer-motion";
import { nanoid } from "nanoid";
import { useEffect, useState } from "react";
import { HexColorPicker } from "react-colorful";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  WorkbenchProjectDesignSystemChoice,
  WorkbenchRunSubmission,
} from "@/lib/workbench/features";
import { cn } from "@/lib/utils";

const workbenchEase = [0.16, 1, 0.3, 1] as const;
const popoverTransition = { duration: 0.13, ease: workbenchEase } as const;
const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i, "请输入 6 位十六进制颜色");
const customDesignSystemFormSchema = z.object({
  title: z.string().trim().min(1, "请输入名称").max(240),
  primaryColor: hexColorSchema,
  accentColor: hexColorSchema,
  backgroundColor: hexColorSchema,
  textColor: hexColorSchema,
  fontFamily: z.string().trim().min(1, "请输入字体").max(240),
  controlRadius: z.coerce.number().int().min(0).max(32),
});

type CustomDesignSystemForm = z.infer<typeof customDesignSystemFormSchema>;
type DesignSystemProvision = NonNullable<WorkbenchRunSubmission["designSystemProvision"]>;

export type WorkbenchDesignStyleSelection = {
  designStyle: RunDesignStyle;
  key: string;
  label: string;
  provision?: DesignSystemProvision;
  swatch: string;
};

export const automaticDesignStyleSelection: WorkbenchDesignStyleSelection = {
  designStyle: { kind: "automatic" },
  key: "automatic",
  label: "自动",
  swatch: "#8f949c",
};

export function designStyleSelectionFromPreset(
  item: DesignPresetCatalogItem,
): WorkbenchDesignStyleSelection {
  return {
    designStyle: {
      kind: "preset",
      presetId: item.presetId,
      version: item.version,
      checksum: item.checksum,
    },
    key: `preset:${item.presetId}@${item.version}:${item.checksum}`,
    label: item.label,
    swatch: item.swatch,
  };
}

export function designStyleSelectionFromCatalog(
  item: DesignSystemCatalogItem,
): WorkbenchDesignStyleSelection {
  return {
    designStyle: { kind: "automatic" },
    key: `catalog:${item.artifactVersionId}`,
    label: item.artifactTitle,
    provision: {
      idempotencyKey: `design-system-import:${nanoid()}`,
      kind: "import",
      sourceArtifactVersionId: item.artifactVersionId,
    },
    swatch: catalogSwatch(item.checksum),
  };
}

export function designStyleSelectionFromProject(
  item: WorkbenchProjectDesignSystemChoice,
): WorkbenchDesignStyleSelection {
  return {
    designStyle: { kind: "artifact", artifactVersionId: item.artifactVersionId },
    key: `artifact:${item.artifactVersionId}`,
    label: item.label,
    swatch: "conic-gradient(#6f85ff 0 25%, #d23b49 25% 50%, #6ab8f5 50% 75%, #4da46a 75%)",
  };
}

export function designStyleSelectionFromCustom(
  request: CreateDesignSystemRequest,
): WorkbenchDesignStyleSelection {
  const primary = request.document.tokens.find((token) => token.path === "color.brand.primary");
  const swatch = primary?.value.kind === "literal" && typeof primary.value.value === "string"
    ? primary.value.value
    : "#6f85ff";
  return {
    designStyle: { kind: "automatic" },
    key: `custom:${request.document.documentId}`,
    label: request.title,
    provision: {
      idempotencyKey: `design-system-create:${nanoid()}`,
      kind: "create",
      request,
    },
    swatch,
  };
}

export function HomeDesignSystemMenu({
  catalogItems,
  fetchingNextPage,
  hasNextPage,
  onCreateCustom,
  onLoadMore,
  onRetry,
  onSelect,
  selected,
  status,
}: {
  catalogItems: DesignSystemCatalogItem[];
  fetchingNextPage: boolean;
  hasNextPage: boolean;
  onCreateCustom: () => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onSelect: (selection: WorkbenchDesignStyleSelection) => void;
  selected: WorkbenchDesignStyleSelection;
  status: "error" | "loading" | "ready";
}) {
  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      aria-busy={status === "loading"}
      className="absolute right-0 bottom-[160px] md:bottom-[112px] z-[70] w-[298px] max-w-full origin-bottom-right overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#18191b]/96 p-[14px] text-[#e8eaed] shadow-[0_24px_90px_-42px_rgba(0,0,0,0.95)] backdrop-blur-2xl"
      exit={{ opacity: 0, scale: 0.992, y: 4 }}
      initial={{ opacity: 0, scale: 0.992, y: 6 }}
      role="menu"
      style={{ maxHeight: "min(430px, calc(100dvh - 160px))", overflowY: "auto" }}
      transition={popoverTransition}
    >
      <div className="mb-[10px] flex items-center gap-[9px] text-[14px] font-semibold text-[#f1f3f4]">
        <PaletteIcon className="size-[16px] text-[#d8dce2]" />
        DESIGN.md
      </div>
      <p className="mb-[12px] whitespace-normal text-[13px] leading-[17px] text-[#aeb3bb]">
        选择或导入一套设计系统后，产品工作台会根据您的偏好自动生成界面。
      </p>
      <button
        className={cn(
          "mb-[12px] flex h-[34px] w-full items-center gap-[9px] rounded-[8px] px-[6px] text-left text-[13px] font-semibold text-[#f1f3f4] hover:bg-white/[0.06]",
          selected.provision?.kind === "create" && "bg-white/[0.10]",
        )}
        onClick={onCreateCustom}
        role="menuitem"
        type="button"
      >
        <PlusIcon className="size-[15px] shrink-0" />
        以您的设计为基础
        {selected.provision?.kind === "create" && <CheckCircle2Icon className="ml-auto size-[15px]" />}
      </button>
      <div className="mb-[6px] px-[6px] text-[13px] font-semibold text-[#9aa0a6]">工作区设计系统</div>
      <DesignStyleMenuItem
        compact={false}
        onSelect={onSelect}
        selected={selected.key === automaticDesignStyleSelection.key}
        selection={automaticDesignStyleSelection}
      />
      {status === "loading" && <DesignSystemMenuSkeleton />}
      {status === "error" && (
        <div className="px-[6px] py-[10px] text-[13px] text-[#c8cbd0]">
          <div className="mb-[8px]">设计系统加载失败</div>
          <button
            className="flex h-[30px] items-center gap-[7px] rounded-[8px] border border-white/[0.10] px-[9px] font-semibold hover:bg-white/[0.06]"
            onClick={onRetry}
            type="button"
          >
            <RefreshCwIcon className="size-[13px]" />
            重试
          </button>
        </div>
      )}
      {status === "ready" && catalogItems.length === 0 && (
        <div className="px-[6px] py-[10px] text-[13px] text-[#9aa0a6]">工作区暂无可用设计系统</div>
      )}
      {status === "ready" && catalogItems.map((item) => (
        <DesignStyleMenuItem
          compact={false}
          key={item.artifactVersionId}
          meta={`${item.projectTitle} · v${item.version}`}
          onSelect={onSelect}
          selected={selected.key === `catalog:${item.artifactVersionId}`}
          selection={designStyleSelectionFromCatalog(item)}
        />
      ))}
      {status === "ready" && hasNextPage && (
        <button
          className="mt-[6px] flex h-[32px] w-full items-center justify-center rounded-[8px] border border-white/[0.08] text-[13px] font-semibold text-[#c8cbd0] hover:bg-white/[0.06] disabled:opacity-50"
          disabled={fetchingNextPage}
          onClick={onLoadMore}
          type="button"
        >
          {fetchingNextPage ? "正在加载..." : "加载更多"}
        </button>
      )}
    </motion.div>
  );
}

export function ProjectDesignSystemMenu({
  onCreateCustom,
  onRetryPresets,
  onSelect,
  presetItems,
  presetStatus,
  projectChoices,
  selected,
}: {
  onCreateCustom: () => void;
  onRetryPresets: () => void;
  onSelect: (selection: WorkbenchDesignStyleSelection) => void;
  presetItems: DesignPresetCatalogItem[];
  presetStatus: "error" | "loading" | "ready";
  projectChoices: WorkbenchProjectDesignSystemChoice[];
  selected: WorkbenchDesignStyleSelection;
}) {
  const projectSelections = projectChoices.map(designStyleSelectionFromProject);
  const presetSelections = presetItems.map(designStyleSelectionFromPreset);
  const options = [
    automaticDesignStyleSelection,
    ...(presetStatus === "ready" ? presetSelections : []),
  ];
  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="absolute bottom-[78px] right-0 w-[300px] max-w-full md:bottom-[48px] md:right-[102px] overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#18191b]/94 p-[12px] text-[#e8eaed] shadow-[0_24px_90px_-42px_rgba(0,0,0,0.95)] backdrop-blur-2xl"
      exit={{ opacity: 0, y: 3 }}
      initial={{ opacity: 0, y: 5 }}
      role="menu"
      style={{ maxHeight: "min(430px, calc(100dvh - 160px))", overflowY: "auto" }}
      transition={popoverTransition}
    >
      <div className="mb-[10px] flex items-center gap-[8px] text-[13px] font-semibold text-[#f1f3f4]">
        <FileTextIcon className="size-[15px] text-[#d8dce2]" />
        DESIGN.md
      </div>
      <p className="mb-[12px] whitespace-normal text-[13px] leading-[17px] text-[#aeb3bb]">
        选择或导入一套设计系统后，产品工作台会根据您的偏好自动生成界面。
      </p>
      <button
        className="mb-[12px] flex h-[34px] w-full items-center gap-[9px] rounded-[8px] px-[6px] text-left text-[13px] font-semibold text-[#f1f3f4] hover:bg-white/[0.06]"
        onClick={onCreateCustom}
        role="menuitem"
        type="button"
      >
        <PlusIcon className="size-[15px] shrink-0" />
        以您的设计为基础
      </button>
      <div className="mb-[6px] px-[6px] text-[13px] font-semibold text-[#9aa0a6]">产品工作台样式</div>
      {options.map((selection) => (
        <button
          aria-pressed={selected.key === selection.key}
          className={cn(
            "flex h-[32px] w-full items-center gap-[9px] rounded-[8px] px-[6px] text-left text-[13px] font-semibold text-[#f1f3f4] hover:bg-white/[0.06]",
            selected.key === selection.key && "bg-white/[0.10]",
          )}
          key={selection.key}
          onClick={() => onSelect(selection)}
          role="menuitem"
          type="button"
        >
          <span className="size-[13px] shrink-0 rounded-full border border-white/[0.12]" style={{ backgroundColor: selection.swatch }} />
          {selection.label}
          {selected.key === selection.key && <CheckCircle2Icon className="ml-auto size-[14px]" />}
        </button>
      ))}
      {presetStatus === "loading" && <DesignSystemMenuSkeleton />}
      {presetStatus === "error" && (
        <div className="px-[6px] py-[8px] text-[13px] text-[#c8cbd0]">
          <div className="mb-[7px]">产品工作台样式加载失败</div>
          <button
            className="flex h-[30px] items-center gap-[7px] rounded-[8px] border border-white/[0.10] px-[9px] font-semibold hover:bg-white/[0.06]"
            onClick={onRetryPresets}
            type="button"
          >
            <RefreshCwIcon className="size-[13px]" />
            重试
          </button>
        </div>
      )}
      {presetStatus === "ready" && presetSelections.length === 0 && (
        <div className="px-[6px] py-[8px] text-[13px] text-[#9aa0a6]">暂无可用产品工作台样式</div>
      )}
      <div className="mb-[6px] mt-[10px] px-[6px] text-[13px] font-semibold text-[#9aa0a6]">项目设计系统</div>
      {projectSelections.length === 0 && (
        <div className="px-[6px] py-[8px] text-[13px] text-[#9aa0a6]">此项目暂无可用设计系统</div>
      )}
      {projectSelections.map((selection, index) => (
        <DesignStyleMenuItem
          compact
          key={selection.key}
          meta={`v${projectChoices[index]?.version ?? 1}`}
          onSelect={onSelect}
          selected={selected.key === selection.key}
          selection={selection}
        />
      ))}
    </motion.div>
  );
}

export function CustomDesignSystemDialog({
  busy,
  onOpenChange,
  onSubmit,
  open,
}: {
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (request: CreateDesignSystemRequest) => void;
  open: boolean;
}) {
  const form = useForm<CustomDesignSystemForm>({
    resolver: zodResolver(customDesignSystemFormSchema),
    defaultValues: customDesignSystemDefaults,
  });
  const [activeColor, setActiveColor] = useState<ColorFieldName>("primaryColor");
  const activeColorValue = form.watch(activeColor);

  useEffect(() => {
    if (!open) return;
    form.reset(customDesignSystemDefaults);
    setActiveColor("primaryColor");
  }, [form, open]);

  const submit = form.handleSubmit((values) => {
    onSubmit(toCreateDesignSystemRequest(values));
    onOpenChange(false);
  });

  return (
    <Dialog onOpenChange={(nextOpen) => !busy && onOpenChange(nextOpen)} open={open}>
      <DialogContent className="max-h-[calc(100dvh-32px)] w-[560px] max-w-[calc(100vw-32px)] overflow-y-auto border-white/[0.10] bg-[#18191b]/98 text-[#f1f3f4]">
        <DialogHeader>
          <DialogTitle>创建项目设计系统</DialogTitle>
        </DialogHeader>
        <form className="grid gap-[18px]" onSubmit={submit}>
          <FormField error={form.formState.errors.title?.message} label="名称">
            <Input
              aria-invalid={Boolean(form.formState.errors.title)}
              autoFocus
              className="rounded-[8px] border-white/[0.10] bg-white/[0.05]"
              {...form.register("title")}
            />
          </FormField>
          <div className="grid gap-[10px]">
            <Label>颜色</Label>
            <div className="grid grid-cols-4 gap-[8px]">
              {colorFields.map((field) => (
                <button
                  aria-pressed={activeColor === field.name}
                  className={cn(
                    "flex min-w-0 items-center gap-[7px] rounded-[8px] border border-white/[0.08] bg-white/[0.03] px-[8px] py-[7px] text-left text-[12px] text-[#c8cbd0]",
                    activeColor === field.name && "border-white/[0.22] bg-white/[0.08] text-[#f1f3f4]",
                  )}
                  key={field.name}
                  onClick={() => setActiveColor(field.name)}
                  type="button"
                >
                  <span
                    className="size-[16px] shrink-0 rounded-full border border-white/[0.16]"
                    style={{ backgroundColor: form.watch(field.name) }}
                  />
                  <span className="truncate">{field.label}</span>
                </button>
              ))}
            </div>
            <div className="grid grid-cols-[160px_1fr] gap-[14px]">
              <HexColorPicker
                className="!h-[132px] !w-[160px]"
                color={activeColorValue}
                onChange={(color) => form.setValue(activeColor, color, { shouldDirty: true, shouldValidate: true })}
              />
              <div className="grid content-start gap-[8px]">
                <Label htmlFor={`design-system-${activeColor}`}>
                  {colorFields.find((field) => field.name === activeColor)?.label}
                </Label>
                <Input
                  aria-invalid={Boolean(form.formState.errors[activeColor])}
                  className="rounded-[8px] border-white/[0.10] bg-white/[0.05] font-mono uppercase"
                  id={`design-system-${activeColor}`}
                  {...form.register(activeColor)}
                />
                {form.formState.errors[activeColor]?.message && (
                  <span className="text-[12px] text-[#f3a6ad]">{form.formState.errors[activeColor]?.message}</span>
                )}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-[1fr_140px] gap-[12px]">
            <FormField error={form.formState.errors.fontFamily?.message} label="界面字体">
              <Input
                aria-invalid={Boolean(form.formState.errors.fontFamily)}
                className="rounded-[8px] border-white/[0.10] bg-white/[0.05]"
                {...form.register("fontFamily")}
              />
            </FormField>
            <FormField error={form.formState.errors.controlRadius?.message} label="控件圆角">
              <Input
                aria-invalid={Boolean(form.formState.errors.controlRadius)}
                className="rounded-[8px] border-white/[0.10] bg-white/[0.05]"
                max={32}
                min={0}
                type="number"
                {...form.register("controlRadius")}
              />
            </FormField>
          </div>
          <DialogFooter>
            <Button disabled={busy} onClick={() => onOpenChange(false)} type="button" variant="ghost">
              取消
            </Button>
            <Button disabled={busy} type="submit">
              {busy ? "处理中..." : "使用此设计"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DesignStyleMenuItem({
  compact,
  meta,
  onSelect,
  selected,
  selection,
}: {
  compact: boolean;
  meta?: string;
  onSelect: (selection: WorkbenchDesignStyleSelection) => void;
  selected: boolean;
  selection: WorkbenchDesignStyleSelection;
}) {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "flex w-full items-center gap-[9px] rounded-[8px] px-[6px] text-left font-semibold text-[#f1f3f4] hover:bg-white/[0.06]",
        compact ? "min-h-[32px] text-[13px]" : "min-h-[38px] text-[13px]",
        selected && "bg-white/[0.10]",
      )}
      onClick={() => onSelect(selection)}
      role="menuitem"
      type="button"
    >
      <span
        className={cn("shrink-0 rounded-full border border-white/[0.12]", compact ? "size-[13px]" : "size-[18px]")}
        style={{ background: selection.swatch }}
      />
      <span className="min-w-0 flex-1 truncate">{selection.label}</span>
      {meta && <span className="max-w-[106px] shrink-0 truncate text-[12px] font-medium text-[#8f949c]">{meta}</span>}
      {selected && <CheckCircle2Icon className="size-[14px] shrink-0" />}
    </button>
  );
}

function DesignSystemMenuSkeleton() {
  return (
    <div aria-label="正在加载设计系统" className="grid gap-[4px] px-[6px] py-[5px]">
      {[0, 1, 2].map((index) => (
        <span
          className="h-[30px] animate-pulse rounded-[8px] bg-white/[0.05]"
          key={index}
        />
      ))}
    </div>
  );
}

function FormField({
  children,
  error,
  label,
}: {
  children: React.ReactNode;
  error?: string;
  label: string;
}) {
  return (
    <label className="grid gap-[7px] text-[13px] font-medium text-[#d8dce2]">
      {label}
      {children}
      {error && <span className="text-[12px] text-[#f3a6ad]">{error}</span>}
    </label>
  );
}

type ColorFieldName = "primaryColor" | "accentColor" | "backgroundColor" | "textColor";

const colorFields: Array<{ label: string; name: ColorFieldName }> = [
  { label: "主色", name: "primaryColor" },
  { label: "强调色", name: "accentColor" },
  { label: "背景", name: "backgroundColor" },
  { label: "文本", name: "textColor" },
];

const customDesignSystemDefaults: CustomDesignSystemForm = {
  title: "项目设计系统",
  primaryColor: "#6f85ff",
  accentColor: "#4da46a",
  backgroundColor: "#18191b",
  textColor: "#f1f3f4",
  fontFamily: "Inter",
  controlRadius: 8,
};

function toCreateDesignSystemRequest(values: CustomDesignSystemForm): CreateDesignSystemRequest {
  const documentId = `design-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
  return {
    title: values.title.trim(),
    document: {
      protocol: "workbench.design-system.v1",
      documentId,
      title: values.title.trim(),
      tokens: [
        designToken("token-primary", "color.brand.primary", "color", values.primaryColor, "品牌主色"),
        designToken("token-accent", "color.brand.accent", "color", values.accentColor, "品牌强调色"),
        designToken("token-background", "color.surface.canvas", "color", values.backgroundColor, "界面背景色"),
        designToken("token-text", "color.text.primary", "color", values.textColor, "主要文本色"),
        designToken("token-font-body", "typography.fontFamily.body", "fontFamily", values.fontFamily.trim(), "界面字体"),
        designToken("token-radius-control", "shape.radius.control", "dimension", `${values.controlRadius}px`, "控件圆角"),
      ],
      assets: [],
      principles: [{
        id: "principle-consistency",
        title: "一致性",
        description: "界面层级、颜色和控件表达保持一致。",
      }],
      guidelines: [{
        id: "guideline-foundation",
        title: "基础视觉规范",
        description: "生成界面时使用本设计系统的颜色、字体和圆角令牌。",
        principleIds: ["principle-consistency"],
        tokenPaths: [
          "color.brand.primary",
          "color.brand.accent",
          "color.surface.canvas",
          "color.text.primary",
          "typography.fontFamily.body",
          "shape.radius.control",
        ],
        componentIds: [],
      }],
      components: [],
    },
  };
}

function designToken(
  id: string,
  path: string,
  type: "color" | "dimension" | "fontFamily",
  value: string,
  description: string,
) {
  return {
    id,
    path,
    type,
    value: { kind: "literal" as const, value },
    description,
  };
}

function catalogSwatch(checksum: string): string {
  const colors = ["#6f85ff", "#d23b49", "#6ab8f5", "#4da46a", "#d8b45c", "#8f71d9"];
  const index = Number.parseInt(checksum.slice(0, 2), 16) % colors.length;
  return colors[index] ?? colors[0]!;
}
