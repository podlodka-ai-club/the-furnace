import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ListWorkflowsStatusFilter,
  TicketWorkflowDetail,
  TicketWorkflowSummary,
} from "../../src/temporal/ticket-activity-types.js";
import { ApiError, getTicketWorkflow, listTicketWorkflows } from "./api";
import { WorkflowList } from "./components/WorkflowList";
import { WorkflowDetail } from "./components/WorkflowDetail";

const LIST_POLL_MS = 15_000;
const DETAIL_POLL_MS = 5_000;

const STATUS_FILTERS: Array<{ key: ListWorkflowsStatusFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "running", label: "Running" },
  { key: "closed", label: "Closed" },
];

export function App() {
  const [statusFilter, setStatusFilter] = useState<ListWorkflowsStatusFilter>("all");
  const [workflows, setWorkflows] = useState<TicketWorkflowSummary[]>([]);
  const [listLoading, setListLoading] = useState<boolean>(true);
  const [listError, setListError] = useState<string | undefined>();

  const [selected, setSelected] = useState<TicketWorkflowSummary | undefined>();
  const [detail, setDetail] = useState<TicketWorkflowDetail | undefined>();
  const [detailLoading, setDetailLoading] = useState<boolean>(false);
  const [detailError, setDetailError] = useState<string | undefined>();
  const [detailRefreshing, setDetailRefreshing] = useState<boolean>(false);

  const selectedRef = useRef<TicketWorkflowSummary | undefined>(undefined);
  selectedRef.current = selected;

  const fetchList = useCallback(async (): Promise<void> => {
    try {
      const result = await listTicketWorkflows({ status: statusFilter });
      setWorkflows(result);
      setListError(undefined);
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : describeFetchError(err));
    } finally {
      setListLoading(false);
    }
  }, [statusFilter]);

  const fetchDetail = useCallback(
    async (manual: boolean): Promise<void> => {
      const target = selectedRef.current;
      if (!target) return;
      if (manual) setDetailRefreshing(true);
      try {
        const result = await getTicketWorkflow(target.workflowId, target.runId);
        if (selectedRef.current?.workflowId === target.workflowId) {
          setDetail(result);
          setDetailError(undefined);
        }
      } catch (err) {
        const message =
          err instanceof ApiError ? err.message : describeFetchError(err);
        if (selectedRef.current?.workflowId === target.workflowId) {
          setDetailError(message);
        }
      } finally {
        if (manual) setDetailRefreshing(false);
        setDetailLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    setListLoading(true);
    void fetchList();
    const id = window.setInterval(() => void fetchList(), LIST_POLL_MS);
    return () => window.clearInterval(id);
  }, [fetchList]);

  useEffect(() => {
    if (!selected) {
      setDetail(undefined);
      return;
    }
    setDetailLoading(true);
    setDetail(undefined);
    void fetchDetail(false);
  }, [selected, fetchDetail]);

  useEffect(() => {
    if (!detail) return;
    if (detail.status !== "running") return;
    const id = window.setInterval(() => void fetchDetail(false), DETAIL_POLL_MS);
    return () => window.clearInterval(id);
  }, [detail, fetchDetail]);

  const onRefreshDetail = useCallback(() => {
    void fetchDetail(true);
  }, [fetchDetail]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-header__title">The Furnace · Ticket Activity</span>
        <div className="app-header__filters" role="group" aria-label="Status filter">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`filter-button${statusFilter === f.key ? " is-active" : ""}`}
              onClick={() => setStatusFilter(f.key)}
              aria-pressed={statusFilter === f.key}
            >
              {f.label}
            </button>
          ))}
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              setListLoading(true);
              void fetchList();
            }}
            aria-label="Refresh list"
          >
            Refresh
          </button>
        </div>
      </header>
      <WorkflowList
        workflows={workflows}
        selectedWorkflowId={selected?.workflowId}
        onSelect={setSelected}
        loading={listLoading}
        error={listError}
      />
      <WorkflowDetail
        detail={detail}
        loading={detailLoading}
        error={detailError}
        onRefresh={onRefreshDetail}
        refreshing={detailRefreshing}
      />
    </div>
  );
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Unable to reach Furnace API";
}
