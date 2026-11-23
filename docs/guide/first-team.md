# Your first team

For the person at the keyboard: sign in, make a team, add one colleague, build one kind of work and take one item from capture to completion. Each step names the control by the words on the screen and says what the screen shows afterwards. The rules behind each screen are in the developer docs this guide links to; it does not repeat them.

You need two people, or two browsers signed in as two people: **you**, who create the team and become its admin, and **the member**, who captures and completes the item. Running a team after this is in the [admin guide](admin.md).

## Steps

### 1. Sign in

Open the address the instance's owner gave you and select **Sign in**. Each page in GetWorkDone has its own address, which you can bookmark or share with a colleague in the team: opened signed out, it shows that page right after sign-in. The identity provider's sign-in page opens. GetWorkDone has no sign-up: the owner created your user in the instance's user pool and the pool emailed you a temporary password. Sign in with your email and that password; the first sign-in asks you to choose a new one.

Afterwards the header says **Signed in as** your name, your email in brackets, then **subject** and a string of letters and digits, and the page shows **Your teams** with "You are not in a team yet." and the **Create a team** form under it.

### 2. Create a team

In **Create a team**, type the name in **Team name** and select **Create team**. The button stays disabled until the name has more than spaces; a name the API refuses (longer than 120 characters) shows its message under the box.

Afterwards the team's page opens: its name as the heading, **Your role: admin**, the empty **Work types** list ("No work types yet.") and the **New work type** and **Members** buttons. Whoever creates a team is its first admin ([auth.md, "Team membership"](../auth.md#team-membership)).

### 3. Find the member's subject

The member signs in (step 1) in their own browser and reads their header: **Signed in as** their name and email, then **subject** and the value to send you. **Copy subject**, where the browser offers it, copies exactly that value; otherwise it is selectable text. They send it to you.

The subject is the identity provider's `sub` for that person, not their email address: you add people by subject, and there are no email invitations or directory lookup ([auth.md, "Team membership"](../auth.md#team-membership)).

### 4. Add the member

On your team's page select **Members**. The **Members** panel lists one row: your name (or your email, if the identity provider gives no name), your subject and **admin**. Paste the member's subject in **Subject**, choose **member** in **Role** and select **Add member**.

Afterwards the list has a second row: their name and subject and **member**, or only their subject until they first sign in. A subject already in the team is refused with "already a member of this team". When the member reloads their page, **Your teams** lists your team with **(member)**. Select **Back** to return to the team's page.

### 5. Build a work type

Select **New work type**. The builder opens with the heading **New work type**, one field labelled `Field 1`, a **Steps** section ("No steps: a captured item is completed straight away."), an **Outputs** section holding one `persist` output, and a **Preview** of the capture form.

- **Slug**: a short name in lower case with hyphens, such as `requests`.
- The field: set **Label** to `Title` and **Key** to `title`, leave **Type** `text`, and tick **Required**. Field types and their settings are in [capture.md](../capture.md).
- Under **Steps**, select **Add human step**, type a **Step name** such as `Review`, and choose **member** in **Assignee role**. Step kinds and how an item moves through them are in [process.md](../process.md).
- Under **Outputs**, keep the `persist` output ("Keep the captured data"). To also send an email, select **Add output**, which adds a webhook output, set its **Kind** to **email: Email each completed item**, and put one address per line in **Recipients**. In the sandbox an email reaches only an address the owner has verified with the email service; any other ends `failed` with `recipient_not_verified`. Output kinds are in [outputs.md](../outputs.md).
- Select **Create work type**. It stays disabled while anything above shows an error.

Afterwards the team's page lists the work type as its slug with **(version 1)**, with a **Capture** button and, for admins, **Edit fields**.

### 6. Capture an item, as the member

The member selects **Open** beside your team, then **Capture** beside the work type. The page shows **New** and the slug, the form with **Title (required)**, and **Items** with "No items yet." They type a title and select **Submit**.

Afterwards the form says **Saved.** and the **Items** table has one row whose **Status** is `in_progress`: the item waits at the human step. A value the form refuses shows its message under the field and nothing is saved.

### 7. Complete the step, as the member

In that row the member selects **Open**. The **Item** view shows **Status:** `in_progress`, the captured data, and under **Steps** the step `Review (human): waiting for a member` with a **Complete Review** button. They select **Complete Review**.

Afterwards **Status:** is `completed`, the step reads `done`, the button is gone, and **History** lists the item's events, the completion by the member's subject among them.

### 8. See the result

Still in the item view, the **Deliveries** panel lists one row per email or webhook output: **Output**, **Kind**, **Status** (`pending` until the worker sends it, then `delivered` or `failed`), **Attempts**, **Last error** and **When**. Select **Refresh deliveries** to read it again; what each **Last error** reason means is in [outputs.md, "Retry policy"](../outputs.md#retry-policy).

With only the `persist` output the panel says "Nothing to deliver: this item has no email or webhook output, or it has not completed." Select **Back to the items**: the item is in the capture page's **Items** table with **Status** `completed` and its data, which `persist` keeps ([domain.md, "Output semantics"](../domain.md#output-semantics-d-048)).

## Limits you may meet

GetWorkDone caps some things so one person or team cannot exhaust an instance. The numbers live with the rule that sets them, so look them up there:

- Team names, work-type and item rules, and the per-definition and per-person quotas: [domain.md](../domain.md) (GWP#50 adds the quota table there).
- Field settings, patterns and what a capture form refuses: [capture.md](../capture.md).
- Email recipients per output, delivery attempts and deadlines, and exports (how often, how many are kept, for how long, how large): [outputs.md](../outputs.md).
- Sign-in attempts per minute: [auth.md, "Sign-in rate limit"](../auth.md#sign-in-rate-limit).
