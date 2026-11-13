import { useMemo } from 'react'
import { DoorOpen } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/primitives'
import { useOfficeMembers } from '@/hooks/useOffice'
import { useNow } from '@/hooks/useNow'
import { useRespondRoomInvite, useRoomInvites, useRooms } from '@/hooks/useExtras'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'
import { markEnteredRoom } from '@/lib/roomFocus'

/** "Come into the Boardroom": reaches you on every screen, beside the knocks (0021). */
export function RoomInviteLayer() {
  const me = useAuthStore((s) => s.profile?.id)
  const { data: invites } = useRoomInvites()
  const { data: members } = useOfficeMembers()
  const { data: rooms } = useRooms()
  const respond = useRespondRoomInvite()
  const showToast = useToastStore((s) => s.showToast)
  const navigate = useNavigate()
  const now = useNow(15_000).getTime()
  const waiting = (invites ?? []).filter((i) => i.to_user === me && i.status === 'pending' && new Date(i.expires_at).getTime() > now)
  const names = useMemo(() => new Map((members ?? []).map((m) => [m.user_id, m.user?.full_name ?? 'Someone'])), [members])
  const name = (id: string) => names.get(id) ?? 'Someone'
  const room = (id: string) => rooms?.find((r) => r.id === id)?.name ?? 'a room'
  // Announce the newest only: a list re-read on every change is noise.
  const newest = waiting[0]
  const announcement = newest ? `${name(newest.from_user)} invited you to the ${room(newest.room_id)}.` : ''

  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <section
        aria-label="Invites to a room"
        hidden={!waiting.length}
        className="fixed right-4 bottom-20 z-[41] flex w-[min(360px,calc(100vw-32px))] flex-col gap-2 md:top-[76px] md:bottom-auto"
      >
        {waiting.slice(0, 2).map((i) => (
          <div key={i.id} className="knock-in on-dark rounded-[14px] border border-[rgba(246,250,247,0.12)] bg-ink p-4 text-ivory shadow-[var(--shadow-md)]">
            <div className="flex items-start gap-3">
              <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[rgba(255,217,102,0.14)] text-gold">
                <DoorOpen size={18} strokeWidth={1.75} />
              </span>
              <div className="min-w-0">
                <p className="text-[14px] font-medium text-ivory">{name(i.from_user)} invited you</p>
                <p className="mt-0.5 text-[13px] text-[rgba(246,250,247,0.68)]">Join them in the {room(i.room_id)}?</p>
              </div>
            </div>
            <div className="mt-3.5 flex gap-2 pl-[52px]">
              <Button
                className="bg-gold text-ink hover:bg-ivory hover:text-ink max-sm:h-11"
                loading={respond.isPending && respond.variables?.id === i.id && respond.variables.accept}
                onClick={() =>
                  respond.mutate(
                    { id: i.id, accept: true },
                    {
                      onSuccess: () => {
                        markEnteredRoom()
                        navigate('/rooms')
                      },
                      onError: (e) => showToast(e.message, 'error'),
                    },
                  )
                }
              >
                Join<span className="sr-only"> {name(i.from_user)} in the {room(i.room_id)}</span>
              </Button>
              <Button
                variant="ghost"
                className="border border-[rgba(246,250,247,0.22)] text-ivory hover:bg-[rgba(246,250,247,0.08)] hover:text-ivory max-sm:h-11"
                onClick={() => respond.mutate({ id: i.id, accept: false }, { onError: (e) => showToast(e.message, 'error') })}
              >
                Not now<span className="sr-only">, {name(i.from_user)}</span>
              </Button>
            </div>
          </div>
        ))}
      </section>
    </>
  )
}
