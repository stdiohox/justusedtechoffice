/**
 * The staff notice: how the office records working time (0010). Each person
 * acknowledges a version once (ack_office_notice); a new VERSION brings the
 * notice back to everyone. Change the text only with a new VERSION, and have
 * it reviewed (a Nigerian data protection lawyer or a licensed DPCO) before
 * it goes out: tito-crm's OFFICE-ACTIVITY-PLAN.md section 6 and OFFICE-FEATURES-PLAN.md 2.3.
 *
 * Acknowledging means "I have read this", not consent: the lawful basis is
 * JustUsedTech's legitimate interest (NDPA 2023 s.25). Every sentence here
 * must stay true of the code; if the office starts recording something new,
 * the notice changes first.
 */
/** 2 (0011): tasks the team gives each other. */
export const NOTICE_VERSION = 2

export const NOTICE_TITLE = 'How the office records your time'

export interface NoticeSection {
  heading: string
  points: string[]
}

export const NOTICE: NoticeSection[] = [
  {
    heading: 'What is recorded',
    points: [
      'Your three daily reports, with the proof and links you attach, and whether each was on time, by the office server’s clock.',
      'When you are active, away, on do not disturb, working elsewhere, or signed out of the office, and for how long. Active means a key, click or scroll in an office tab.',
      'After 10 minutes with no activity in the office you show as away. After 30 more minutes away you are signed out of the office, and you press “I’m back” to return.',
      'If you choose “Working elsewhere”, a “Still there?” comes about every 30 minutes; answer it within 5 minutes. Do not disturb lasts up to 90 minutes at a time.',
      'What you write on your door, your answers to check-ins, and the notes you add to your day.',
      'Tasks the team gives each other: what the task is, who gave it to whom, its due date, when it was started, done, approved, sent back or cancelled, by whom, and the notes and links added along the way.',
    ],
  },
  {
    heading: 'What is never recorded',
    points: [
      'Your screen, your keystrokes or what you type, mouse movement, other apps or websites, your camera or microphone, your location, or anything on your phone.',
    ],
  },
  {
    heading: 'Who sees it',
    points: [
      'Mr Tito sees your reports, your time figures and your notes, side by side. You see exactly the same figures about yourself under My reports.',
      'Everyone in the office sees what is on your door and whether you are in. Office chats, and your reply when you answer a knock “not now”, are readable only by the two people involved.',
      'Mr Tito sees which first steps you have done in the office, and whether and when you read this notice.',
      'A task is seen by the person who gave it and the person it was given to. The office admins, Mr Tito and Hazel, see every task. Hazel sees only tasks: not your reports, your time figures or your notes.',
    ],
  },
  {
    heading: 'How it is used',
    points: [
      'The figures are a guide, not a verdict. No pay or disciplinary decision is made from them alone: you will always be asked first, and you can add a note to any day.',
      'Proof files, presence, stays, check-ins and day notes are kept for 90 days, then deleted. The text of your reports stays on file.',
      'Purpose: knowing who is at work and supporting fair reviews. Lawful basis: JustUsedTech’s legitimate interest in managing a remote team.',
      'Your login is yours alone. Do not let anyone else use it.',
      'Questions or objections: speak to Mr Tito.',
    ],
  },
]
