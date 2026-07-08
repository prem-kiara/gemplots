'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, Skeleton } from '@/components/Card';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { Button } from '@/components/Button';
import { StatusChip } from '@/components/StatusChip';
import { Countdown } from '@/components/Countdown';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { TextArea } from '@/components/Input';
import { CheckIcon, XIcon, ChevronLeft } from '@/components/icons';
import { useToast } from '@/components/Toast';
import { useApproval } from '@/lib/queries';
import { api, ApiError, getUser } from '@/lib/api';
import { formatINR, formatIST } from '@/lib/format';
import { S } from '@/lib/strings';
import type { Guardrail } from '@/lib/types';

export default function ReviewDetail({ params }: { params: { id: string } }) {
  const id = params.id;
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useApproval(id);

  const [dialog, setDialog] = useState<'approve' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-1/3" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64 w-full rounded-card" />
          <Skeleton className="h-64 w-full rounded-card" />
        </div>
      </div>
    );
  }
  if (error instanceof ApiError && error.status === 404) {
    return <EmptyState title="Approval not found" cta={S.common.back} onCta={() => router.push('/admin/inbox')} />;
  }
  if (!data) return <ErrorState message={S.common.somethingWrong} onRetry={() => refetch()} />;

  const me = getUser();
  const isMaker = !!me && me.id === data.requested_by;
  const anyGuardrailFails = data.guardrails.some((g) => !g.ok);
  const pending = data.status === 'PENDING';
  const approveDisabled = anyGuardrailFails || isMaker || !pending;
  const snap = data.snapshot;

  async function decide(kind: 'approve' | 'reject') {
    setSubmitting(true);
    try {
      await api(`/v1/admin/approvals/${id}/${kind}`, {
        method: 'POST',
        body: kind === 'reject' ? { note } : note ? { note } : {},
      });
      toast.success(kind === 'approve' ? S.admin.review.approved : S.admin.review.rejected);
      qc.invalidateQueries({ queryKey: ['admin'] });
      router.push('/admin/inbox');
    } catch (err) {
      if (err instanceof ApiError) {
        const map: Record<string, string> = {
          SELF_APPROVAL_FORBIDDEN: S.admin.review.selfApproval,
          GUARDRAIL_FAILED: S.admin.review.guardrailFailed,
          APPROVAL_NOT_PENDING: S.admin.review.notPending,
        };
        toast.error(map[err.code] ?? err.message);
      } else toast.error(S.common.somethingWrong);
      refetch();
    } finally {
      setSubmitting(false);
      setDialog(null);
    }
  }

  return (
    <div className="space-y-4">
      <button
        onClick={() => router.push('/admin/inbox')}
        className="inline-flex items-center gap-1 text-gp-sm font-semibold text-muted hover:text-ink"
      >
        <ChevronLeft width={16} height={16} />
        {S.admin.inbox.title}
      </button>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-gp-xl font-semibold text-ink">{data.summary}</h1>
        <StatusChip status={data.status} />
      </div>
      <p className="text-gp-sm text-muted">
        Requested by {data.maker_email ?? '—'} · {formatIST(data.created_at)}
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Reservation context (RESERVE_PLOT) */}
        {snap && (
          <Card className="p-5">
            <h2 className="mb-3 text-gp-base font-semibold text-ink">{S.admin.review.customer}</h2>
            <dl className="space-y-2 text-gp-sm">
              <Row label="Name" value={snap.customer?.name || '—'} />
              <Row
                label="Email"
                value={
                  <span className="inline-flex items-center gap-1.5">
                    {snap.customer?.email || '—'}
                    {snap.reserve_confirmed_at && (
                      <span className="inline-flex items-center gap-0.5 text-primary">
                        <CheckIcon width={13} height={13} />
                        {S.admin.review.emailVerified}
                      </span>
                    )}
                  </span>
                }
              />
              <Row label="Phone" value={snap.customer?.phone || '—'} />
            </dl>
            <hr className="my-4 border-line" />
            <h2 className="mb-3 text-gp-base font-semibold text-ink">{S.admin.review.plot}</h2>
            <dl className="space-y-2 text-gp-sm">
              <Row label="Plot" value={snap.plot?.plot_number || '—'} />
              <Row label="Project" value={snap.plot?.project_name || '—'} />
              <Row
                label={S.admin.review.price}
                value={
                  <span className="font-semibold text-primary">
                    {formatINR(snap.booking?.total_price_paise ?? null)}
                  </span>
                }
              />
            </dl>
          </Card>
        )}

        {/* Guardrails */}
        <Card className="p-5">
          <h2 className="mb-3 text-gp-base font-semibold text-ink">{S.admin.review.guardrails}</h2>
          <ul className="space-y-2">
            {data.guardrails.map((g: Guardrail) => (
              <li key={g.name} className="flex items-start gap-2 text-gp-sm">
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                    g.ok ? 'bg-primary/15 text-primary' : 'bg-danger/15 text-danger'
                  }`}
                >
                  {g.ok ? <CheckIcon width={13} height={13} /> : <XIcon width={13} height={13} />}
                </span>
                <span>
                  <span className="font-medium text-ink">{g.name}</span>
                  {g.detail && <span className="text-muted"> — {g.detail}</span>}
                </span>
              </li>
            ))}
          </ul>

          {pending && (
            <>
              {snap && (
                <div className="mt-4">
                  <p className="text-gp-sm text-muted">{S.admin.review.decisionWithin}</p>
                  {data.snapshot?.booking && (
                    <BookingCountdown bookingId={data.entity_id} />
                  )}
                </div>
              )}
              <div className="mt-5 flex gap-2">
                <Button
                  onClick={() => setDialog('approve')}
                  disabled={approveDisabled}
                  title={approveDisabled ? S.admin.review.blockedByGuardrail : undefined}
                >
                  {S.admin.review.approve}
                </Button>
                <Button variant="danger" onClick={() => setDialog('reject')}>
                  {S.admin.review.reject}
                </Button>
              </div>
              {isMaker && <p className="mt-2 text-gp-sm text-accent">{S.admin.review.selfApproval}</p>}
              {anyGuardrailFails && !isMaker && (
                <p className="mt-2 text-gp-sm text-danger">{S.admin.review.blockedByGuardrail}</p>
              )}
            </>
          )}
        </Card>
      </div>

      <ConfirmDialog
        open={dialog === 'approve'}
        title={S.admin.review.approveConfirm}
        confirmLabel={S.admin.review.approve}
        loading={submitting}
        onConfirm={() => decide('approve')}
        onCancel={() => setDialog(null)}
      >
        <TextArea
          label={S.admin.review.noteOptional}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'reject'}
        title={S.admin.review.rejectConfirm}
        confirmLabel={S.admin.review.reject}
        confirmVariant="danger"
        loading={submitting}
        disabled={!note.trim()}
        onConfirm={() => decide('reject')}
        onCancel={() => setDialog(null)}
      >
        <TextArea
          label={S.admin.review.noteRequired}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </ConfirmDialog>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right text-ink">{value}</dd>
    </div>
  );
}

// The approval snapshot has no expires_at; we pull the live booking to show the decision window.
function BookingCountdown({ bookingId }: { bookingId: string }) {
  const { data } = useBookingLite(bookingId);
  if (!data?.expires_at) return <span className="text-gp-sm text-muted">—</span>;
  return <Countdown expiresAt={data.expires_at} />;
}

function useBookingLite(id: string) {
  return useQuery({
    queryKey: ['booking', id],
    queryFn: () => api<{ expires_at: string }>(`/v1/bookings/${id}`),
    enabled: !!id,
  });
}
