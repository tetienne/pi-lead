# Issue tracker: Local Markdown

Specs live at `.scratch/<feature>/spec.md`; tickets live in separate files at `.scratch/<feature>/issues/<NN>-<slug>.md`, numbered from 01 in dependency order.

Each ticket declares its canonical triage role in `Status`, acceptance criteria,
and blocking tickets. Append discussion under a Comments heading. Completed
work retains its last triage role and declares `Resolution: DONE`; an
intentionally deferred or superseded ticket uses `Status: wontfix` and explains
the decision in Comments. Work on a ticket only after all its blockers are done
and its implementation is authorized.

Publishing to the tracker means writing local files. Fetching a ticket means reading its file. Spec approval and approval of ticket granularity precede implementation.

For wayfinding, use `.scratch/<effort>/map.md` and one decision ticket per file in its issues directory. Decision tickets carry Type, Status, and Blocked by fields; claim before working and record the answer before marking resolved. The frontier is the open, unclaimed tickets whose blockers are resolved, ordered by number. Link resolved answers from the map without duplicating them.
