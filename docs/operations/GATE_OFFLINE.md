# Gate procedure when VEYRA cannot be reached

For security supervisors and guards. Applies to every property using the VEYRA gate screen.
Owner decisions of 2026-11-11: offline lists are trusted for **4 hours**; guards may admit on an
offline check themselves; entries the pass would not have allowed go to **supervisor review**.

## 1. While the gate screen is still open: offline mode

The gate screen saves a list of the passes expected in the next 4 hours every 15 minutes while
it has a connection. When the connection drops, the screen says **No connection** and keeps
working:

- **Checking a pass.** Type the reference code or scan the QR code as usual. The answer says
  **Valid pass (offline check)**. Cancellations made since the list was saved can be missing, so
  check identity with extra care. A pass is never proof of identity.
- **Admitting or refusing.** Works as usual. The entry is saved on this device ("waiting to be
  sent") and sent automatically when the connection returns.
- **Visitors without a pass.** To the property itself (e.g. a delivery to the gate office):
  record as usual. **To a unit: not possible offline**, because a resident must approve. Follow
  section 2.
- **Departures.** Record as usual, including for visitors admitted while offline.
- **After 4 hours offline** the list is no longer trusted and every check is refused. Follow
  section 2.

When the connection returns, the screen reports how many entries were recorded, how many will
be reviewed by a supervisor, and any that could not be recorded. **Write any that could not be
recorded in the paper log.**

## 2. Paper procedure

Use it when the gate screen cannot be used: no offline list, list older than 4 hours, device
failure, or a visitor without a pass asking for a unit.

1. Write each event in the gate log book, one line each:
   - date and time (property time), gate, guard's name;
   - what happened: admitted on a pass / admitted without a pass / refused / left;
   - the pass's reference code if there is one, otherwise the visitor's name and type
     (guest, delivery, contractor, service provider);
   - the unit, if going to one; the reason, if refused.
2. **Visitors without a pass going to a unit:** do not admit unless a resident of the unit
   confirms in person or by phone. Write who confirmed and how. These entries will always be
   reviewed.
3. Check identity as usual. A reference code alone is never enough.
4. Never write residents' or visitors' phone numbers in the log book.

## 3. After an outage (supervisor)

1. Within 7 days, type each paper entry into **Visitors → Enter from the paper log**, using the
   time it happened. Entries older than 7 days are refused: write an incident report instead.
2. Open **Visitors → Needs review**. It lists offline and paper entries that the pass would not
   have allowed at the time (cancelled, expired, already used, resident moved out, or a walk-in
   to a unit without approval). Look into each one (ask the guard, call the resident) and mark
   it reviewed with a note. Entries are never deleted.
3. Keep the paper log book for the retention period set for the property.

## 4. Device care

The offline list holds visitor names, plates and unit numbers for at most 4 hours ahead, and
pass hashes (never codes). Keep the gate phone locked when unattended and signed in only by
security staff. Report a lost gate phone to the supervisor at once: cancel and re-issue the
passes expected in the next 4 hours.
