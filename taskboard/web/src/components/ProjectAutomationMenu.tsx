import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type AutomationModel,
  type AutomationReasoningEffort,
} from "../../../shared/taskboard-automation-options.mjs";
import { getAiChatCatalog } from "../api";
import type { AiChatModel } from "../types";
import { LinearIcon } from "./LinearIcon";

type AutomationStatus = "ACTIVE" | "PAUSED";
type AutomationQuotaState = "available" | "blocked" | "unknown" | "unavailable";

interface AutomationOptions {
  enabledByUser: boolean;
  quotaAware: boolean;
  model: AutomationModel;
  reasoningEffort: AutomationReasoningEffort;
}

interface AutomationState extends AutomationOptions {
  status: AutomationStatus;
  quota?: {
    state: AutomationQuotaState;
    checkedAt: number;
    resetsAt?: number;
    reason?: "api-key";
  };
}

interface ProjectAutomationMenuProps {
  projectId: string;
  automation?: Partial<AutomationState>;
  pending: boolean;
  error: string | null;
  unavailableReason: string | null;
  onOpen: () => void;
  onChange: (options: AutomationOptions) => void;
}

const DEFAULT_OPTIONS: AutomationOptions = {
  enabledByUser: false,
  quotaAware: false,
  model: "gpt-5.5",
  reasoningEffort: "high",
};

const EFFORT_LABELS: Record<AutomationReasoningEffort, string> = {
  low: "轻度",
  medium: "中",
  high: "高",
  xhigh: "极高 (xhigh)",
  max: "最高",
  ultra: "极高 (ultra)",
};

export function ProjectAutomationMenu({
  projectId,
  automation,
  pending,
  error,
  unavailableReason,
  onOpen,
  onChange,
}: ProjectAutomationMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wasPendingRef = useRef(pending);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const [draft, setDraft] = useState<AutomationOptions>(DEFAULT_OPTIONS);
  const [models, setModels] = useState<AiChatModel[]>([]);
  const [catalogPending, setCatalogPending] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const selectedModel = models.find(model => model.slug === draft.model);
  const validSelection = Boolean(selectedModel?.supportedReasoningEfforts.includes(draft.reasoningEffort));
  const status = automation?.status ?? "PAUSED";
  const quota = automation?.quota;
  const stateLabel = !automation?.enabledByUser
    ? "已暂停"
    : automation.quotaAware && quota?.state === "blocked"
      ? "等待额度"
      : automation.quotaAware && quota?.state === "unavailable"
        ? "额度不可用"
        : status === "ACTIVE"
          ? "等待新议题"
          : "已暂停";
  const disabled = pending || Boolean(unavailableReason);

  useEffect(() => { setOpen(false); }, [projectId]);
  useEffect(() => {
    if (!open) return;
    let retired = false;
    setCatalogPending(true); setCatalogError(""); setModels([]);
    void getAiChatCatalog(projectId).then(catalog => {
      if (retired) return;
      setModels(catalog.models);
      if (!automation?.model && catalog.models[0]) setDraft(current => ({ ...current,
        model: catalog.models[0].slug, reasoningEffort: catalog.models[0].defaultReasoningEffort }));
    }, error => { if (!retired) setCatalogError(error instanceof Error ? error.message : "原生模型目录不可用"); })
      .finally(() => { if (!retired) setCatalogPending(false); });
    return () => { retired = true; };
  }, [open, projectId]);

  useEffect(() => {
    if (!open) return;
    setDraft({ ...DEFAULT_OPTIONS, ...automation });
  }, [open]);

  useEffect(() => {
    if (wasPendingRef.current && !pending) {
      setDraft({ ...DEFAULT_OPTIONS, ...automation });
    }
    wasPendingRef.current = pending;
  }, [automation, pending]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8));
    const top = trigger.bottom + 8 + menu.height <= window.innerHeight
      ? trigger.bottom + 8
      : Math.max(8, trigger.top - menu.height - 8);
    setPosition({ left, top, ready: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function closeFromViewportChange() {
      setOpen(false);
    }
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    window.addEventListener("resize", closeFromViewportChange);
    window.addEventListener("scroll", closeFromViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
      window.removeEventListener("resize", closeFromViewportChange);
      window.removeEventListener("scroll", closeFromViewportChange, true);
    };
  }, [open]);

  const submitChange = (next: AutomationOptions) => {
    if (disabled) return;
    const model = models.find(model => model.slug === next.model);
    if (next.enabledByUser && (catalogPending || !model?.supportedReasoningEfforts.includes(next.reasoningEffort))) return;
    setDraft(next);
    onChange(next);
  };

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="project-automation-menu no-drag"
      role="dialog"
      aria-label="新议题触发认领设置"
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    >
      <div className="project-automation-menu-heading">
        <strong>新议题触发认领</strong>
        <span className={status === "ACTIVE" ? "is-active" : "is-paused"}>
          {stateLabel}
        </span>
      </div>
      <div className="project-automation-switch">
        <span>新建议题时自动认领</span>
        <button
          type="button"
          className={`board-setting-switch${draft.enabledByUser ? " is-on" : ""}`}
          role="switch"
          aria-checked={draft.enabledByUser}
          disabled={disabled || (!draft.enabledByUser && (catalogPending || !validSelection))}
          onClick={() => submitChange({
            ...draft,
            enabledByUser: !draft.enabledByUser,
          })}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <div className="project-automation-switch">
        <span>认领前检查额度</span>
        <button
          type="button"
          className={`board-setting-switch${draft.quotaAware ? " is-on" : ""}`}
          role="switch"
          aria-checked={draft.quotaAware}
          disabled={disabled || catalogPending}
          onClick={() => submitChange({
            ...draft,
            quotaAware: !draft.quotaAware,
          })}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      {draft.quotaAware && (
        <div className={`project-automation-quota is-${quota?.state ?? "unknown"}`}>
          {quota?.state === "available" && "当前额度可用"}
          {quota?.state === "blocked" && (
            quota.resetsAt
              ? `额度已用尽，预计 ${formatResetTime(quota.resetsAt)} 恢复；本次不会启动`
              : "额度已用尽，本次不会启动"
          )}
          {quota?.state === "unavailable" && (
            quota.reason === "api-key"
              ? "API Key 模式不支持读取 Codex App 额度"
              : "当前账户无法读取额度"
          )}
          {(!quota || quota.state === "unknown") && "额度状态未知；新建议题时会再次检查"}
        </div>
      )}
      <label className="project-automation-field">
        <span>模型</span>
        <select
          value={draft.model}
          disabled={disabled || catalogPending}
          onChange={(event) => {
            const model = models.find(model => model.slug === event.target.value);
            if (model) submitChange({ ...draft, model: model.slug, reasoningEffort: model.supportedReasoningEfforts.includes(draft.reasoningEffort)
              ? draft.reasoningEffort : model.defaultReasoningEffort });
          }}
        >
          {!selectedModel && <option value={draft.model}>{draft.model}（当前不可用）</option>}
          {models.map((model) => (
            <option key={model.slug} value={model.slug}>{model.displayName}</option>
          ))}
        </select>
      </label>
      <label className="project-automation-field">
        <span>推理强度</span>
        <select
          value={draft.reasoningEffort}
          disabled={disabled || catalogPending || !selectedModel}
          onChange={(event) => submitChange({
            ...draft,
            reasoningEffort: event.target.value as AutomationReasoningEffort,
          })}
        >
          {(selectedModel?.supportedReasoningEfforts ?? []).map((effort) => (
            <option key={effort} value={effort}>{EFFORT_LABELS[effort] ?? effort}</option>
          ))}
        </select>
      </label>
      <p className="project-automation-note">
        新建议题后立即启动，依次处理待办。
        <br />
        清空后结束；下条新议题会再次触发。
      </p>
      {unavailableReason && <p className="project-automation-note">{unavailableReason}</p>}
      {catalogPending && <p className="project-automation-note">正在读取原生模型目录…</p>}
      {catalogError && <p className="project-automation-error" role="alert">{catalogError}</p>}
      {error && error !== unavailableReason && <p className="project-automation-error" role="alert">{error}</p>}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`project-automation-trigger no-drag ${status === "ACTIVE" ? "is-active" : "is-paused"}`}
        aria-label={status === "ACTIVE" ? "新议题自动认领" : "未启用自动认领"}
        aria-busy={pending}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={status === "ACTIVE" ? "新议题自动认领" : "未启用自动认领"}
        onClick={() => {
          if (!open) {
            setPosition((current) => ({ ...current, ready: false }));
            onOpen();
          }
          setOpen((current) => !current);
        }}
      >
        <LinearIcon name={status === "ACTIVE" ? "play" : "pause"} />
        <span>{status === "ACTIVE" ? "新议题触发" : "未启用认领"}</span>
      </button>
      {menu}
    </>
  );
}

function formatResetTime(value: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value * 1_000));
}
