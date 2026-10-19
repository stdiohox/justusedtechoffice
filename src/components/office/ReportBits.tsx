import { useState } from 'react'
import { ExternalLink, FileText, Image as ImageIcon } from 'lucide-react'
import { openProof, type ReportWithFiles } from '@/hooks/useOffice'
import { officeClock, type CheckpointState } from '@/lib/office'
import { cn } from '@/lib/utils'

const CHIP = 'inline-flex items-center rounded-[8px] px-2 py-[3px] text-[11px] font-medium whitespace-nowrap'

/** One vocabulary for a checkpoint's state, on both the member's and Mr Tito's screens. */
export function StatusChip({ state, className }: { state: CheckpointState; className?: string }) {
  const [text, tone] =
    state.state === 'filed'
      ? state.timing === 'on_time'
        ? ['On time', 'bg-tint-brand text-state-success']
        : // Primary text, not state-warning: warning on its own tint is
          // under 4.5:1 at 11px. The tint and the word carry the meaning.
          ['Late', 'bg-tint-warning text-text-primary']
      : state.state === 'upcoming'
        ? [`Opens ${state.opens}`, 'bg-surface-sunken text-text-secondary']
        : state.state === 'open'
          ? [`Due by ${state.deadline}`, 'bg-tint-accent text-text-primary']
          : state.state === 'overdue'
            ? ['Overdue', 'bg-tint-danger text-state-danger']
            : ['Not filed', 'bg-tint-danger text-state-danger']
  return <span className={cn(CHIP, tone, className)}>{text}</span>
}

/** Proof files. Each opens through a short-lived signed URL. */
export function ProofList({ report }: { report: ReportWithFiles }) {
  const [problem, setProblem] = useState<string | null>(null)
  if (!report.files.length) return null
  return (
    <div className="mt-2 space-y-1">
      {report.files.map((f) =>
        f.purged_at ? (
          <p key={f.id} className="text-[12px] text-text-muted">
            {f.file_name}: deleted after the retention period
          </p>
        ) : (
          <button
            key={f.id}
            type="button"
            onClick={() => {
              setProblem(null)
              openProof(f.storage_path).catch((err: unknown) =>
                setProblem(err instanceof Error ? err.message : 'Could not open that file.'),
              )
            }}
            className="flex max-w-full items-center gap-1.5 text-left text-[13px] text-brand hover:underline focus-visible:underline max-sm:min-h-11"
          >
            {f.mime_type === 'application/pdf' ? (
              <FileText size={14} strokeWidth={1.75} className="shrink-0" />
            ) : (
              <ImageIcon size={14} strokeWidth={1.75} className="shrink-0" />
            )}
            <span className="truncate">{f.file_name}</span>
            <span className="sr-only"> (opens in a new tab)</span>
          </button>
        ),
      )}
      {problem ? (
        <p role="alert" className="text-[12px] text-state-danger">
          {problem}
        </p>
      ) : null}
    </div>
  )
}

/** What was filed: when, the words, the link, the proof. */
export function ReportDetail({ report, zone }: { report: ReportWithFiles; zone: string }) {
  return (
    <div className="text-[13px]">
      <p className="tnum text-text-muted">Filed {officeClock(zone, report.submitted_at)}</p>
      {report.body ? <p className="mt-1 whitespace-pre-wrap text-text-primary">{report.body}</p> : null}
      {report.link ? (
        <a
          href={report.link}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 flex max-w-full items-center gap-1.5 text-brand hover:underline max-sm:min-h-11"
        >
          <ExternalLink size={13} strokeWidth={1.75} className="shrink-0" aria-hidden />
          <span className="truncate">{report.link}</span>
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : null}
      <ProofList report={report} />
    </div>
  )
}
