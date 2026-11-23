# Running a team: the admin guide

For a team's admins, after [your first team](first-team.md). Each section says what the SPA offers, when it offers it and what the screen shows; the rules themselves are in the developer docs it links to.

## Members

Open the team and select **Members** ([auth.md, "Team membership"](../auth.md#team-membership) has the rules and routes).

- **The list**: each row shows the member's name, else their email, as their identity provider gave it at their last sign-in, then their subject and role. Someone who has not signed in since being added (or since names were added to the list) shows only their subject until they do.
- **Add**: type the person's subject in **Subject**, choose **member** or **admin** in **Role**, select **Add member**. The subject is what the person sees after **subject** in their own header (the identity provider's `sub`), never their email. Someone who has not signed in yet can be added; they see the team when they first sign in. A subject already in the team is refused with "already a member of this team", whatever its role.
- **Remove**: the **Remove** button on the member's row. The row goes at once and they lose the team.
- **Change a role**: there is no control for it. Remove the member and add them again with the other role.
- **The last admin**: a team always keeps an admin. Removing its only admin is refused with "A team needs an admin" and the row stays; add a second admin first. If two admins remove each other at the same moment, one of the removals is refused.
- **Leaving**: an admin may remove themself while another admin remains. They lose the team at once and the SPA takes them back to their team list.

## Work types and versions

**New work type** opens the builder; **Edit fields** on a work type opens it again with the heading **Edit**, the slug and **(next version: N)**. **Save new version** saves the next version; the list then shows the work type with the new version number.

A version never changes once saved, and nothing deletes one ([domain.md, "Rules the database enforces"](../domain.md#rules-the-database-enforces)). Each item keeps the version it was captured under: its steps, fields and outputs stay those of that version, and the capture page shows the fields an older item has that the latest version lacks in extra columns headed by the key ([capture.md, "The builder and the capture form"](../capture.md#the-builder-and-the-capture-form)). A member whose capture page still shows an older version can submit what it shows while the latest version accepts it; when the API refuses a key the form does not know, the page says "This work type has changed", reloads with the new fields and keeps what was typed.

**Archive** on a work type retires it: it moves to the collapsed **Archived work types** section below the list, takes no new items or versions (a capture page still open on it shows "This work type is archived" when submitted), and its items, exports and downloads stay readable from **Items** there. Items already in flight carry on to completion and delivery. An archived work type does not count against the team's limit of work types, so archiving one frees a place for a new one. **Unarchive** in that section brings it back, unless the team already has as many active work types as its limit allows: then it is refused with "This team has reached its limit of … work types" and stays archived until another is archived. Nothing deletes a work type ([process.md, "The API"](../process.md#the-api)).

## When an item stops: Retry, Edit data, Resume and Cancel

Open the item from the capture page's **Items** table (**Open**), or from **Waiting for you** at the top of the team page, which lists the items waiting at a human step whose role you hold across the team's work types, with their count. The item view shows its **Status:**, its data, its **Steps** and **History**. The buttons below appear only when they apply, and all but **Complete** only to admins ([process.md](../process.md) has each rule):

| Button | Offered when | What it does |
|---|---|---|
| **Retry** and the step's name (such as **Retry Upper-case**) | The item is `failed`, on the step it failed at | Runs that step once more against the item's data as it stands; on success the item moves on ([process.md, "Retry"](../process.md#retry)). |
| **Edit data**, then **Save data** or **Cancel** | The item is `failed`, or `in_progress` and waiting at a human step that has started | Replaces the item's data, checked against the fields of the item's own version; the status and step do not change, so a failed item is then retried ([process.md, "Editing data"](../process.md#editing-data)). While the form is open the other buttons wait. |
| **Resume** | The item is `open`, or `in_progress` and not waiting at a started human step: its processing stopped between two steps | Moves the item on from where it stands, as the request that stopped would have ([process.md, "Resume"](../process.md#resume)). The stuck-item sweeper does the same by itself once the item has gone 10 minutes without a change, within about 5 more; Resume is for not waiting. |
| **Complete** and the step's name | The item waits at a human step whose assignee role is `member`, or `admin` for an admin | Completes the step, with the **Decision** (one of the step's decisions when it lists them) and **Comment** beside it recorded in the history; members see it too for `member` steps ([process.md, "Decisions"](../process.md#decisions)). |
| **Cancel item**, then **Confirm cancel** or **Keep the item** | The item is `open`, `in_progress` or `failed` | Stops the item for good with an optional **Reason**, shown in the history: no step runs, no output fires and its data is kept. It cannot be undone ([process.md, "Cancel"](../process.md#cancel)). |

A change another admin made first is refused as out of date, and the view reloads the item: read it again before you act.

## Deliveries

The item view's **Deliveries** panel lists one row per email or webhook output of a completed item: **Status** is `pending` while the worker is still trying, then `delivered` or `failed`, with the **Attempts** made and the **Last error** reason. **Refresh deliveries** reads them again. What each reason means, and which ones are tried again, is the retry policy table in [outputs.md, "Retry policy"](../outputs.md#retry-policy). There is no button to send a delivery again.

Two you may see in the sandbox: `recipient_not_verified`, an email to an address the owner has not verified (it is never retried), and `email_not_configured`, an instance with no email transport.

## Exports

A work type whose latest version has an `export` output shows an **Exports** panel on its capture page: choose CSV or JSON in **Format**, and **Export completed items** builds a file of the team's completed items of that work type, across all its versions, and lists it as a download link (format, item count, time). Any member may export ([outputs.md, "Exports"](../outputs.md#exports)). Its limits:

- one export per work type every 30 seconds: one asked for sooner is refused, and the button then stays disabled while the panel counts down ("You can export again in N seconds.");
- the 10 newest per work type are kept; an eleventh deletes the oldest;
- a team's exports older than 7 days are deleted the next time the team exports;
- a file over 10 MB is refused and nothing is stored.

## What an admin cannot do

- See or change another team: every team route answers 403 to someone who is not in the team, admin of another team or not ([domain.md, "Tenancy"](../domain.md#tenancy)).
- Change a completed item's data: **Edit data** is offered only for a `failed` item or one waiting at a human step.
- Change or delete a saved version: save a new one instead; items keep theirs.
- Change a member's role in place, or remove a team's last admin (see Members).
- Send a failed delivery again, or read a webhook output's signing secret after the save that showed it ([outputs.md, "The signing secret"](../outputs.md#the-signing-secret)).
