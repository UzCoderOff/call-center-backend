const { EventEmitter } = require("events");

// In-process event bus — the extension point for features that react to
// things happening elsewhere, without the code that makes them happen
// needing to know about them.
//
// The planned AI pipeline is the main reason this exists: instead of
// editing the sync route to "also transcribe", an AI module subscribes:
//
//   events.on("calls.synced", ({ callIds, recordingCallIds }) => {
//     // create Transcript rows with status "pending" for recordingCallIds
//     // and let a worker pick them up
//   });
//
// Events currently emitted:
//   "calls.synced"  { employeeId, callIds, recordingCallIds }
//                   after a device sync is fully written to the DB
//   "appointment.booked"      { appointmentId }
//   "appointments.cancelled"  { appointmentIds, byUserId }
//                   a booking made / cancelled (one, or several when the
//                   lawyer changes a day that already had bookings)
//   "material.published"      { materialId, byUserId }
//                   a training material the manager chose to announce
//   "task.created"            { taskId }   a task given (or given to someone else)
//   "task.done"               { taskId, byUserId }
//
// The Telegram notifications (src/services/telegram/) are built on these.
//
// Listeners must not throw into the emitter's caller (the device sync
// response). `safeOn` wraps a handler so a bug in one feature can never
// break syncing.
const events = new EventEmitter();

function safeOn(name, handler) {
  events.on(name, (payload) => {
    Promise.resolve()
      .then(() => handler(payload))
      .catch((err) => console.error(`[events] "${name}" handler failed:`, err));
  });
}

module.exports = { events, safeOn };
