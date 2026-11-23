# Item view: a data edit refused as stale kept the old form open

Resolved before merge in GWP#23, found by the branch's fresh-context whole-branch review.

- **The old form's values could overwrite a newer edit.** When Save data was refused as stale (409), the item view reloaded the item but left the edit form open with the values it was prefilled with, because `CaptureForm` reads `initialData` only when it mounts. The next Save data sent the reloaded `rowVersion` with those old values, so another admin's edit made in between was silently overwritten. If the reload showed the item could no longer be edited, the form unmounted with its error and the admin saw no reason.
- **Other actions moved the item under an open form.** Retry, Complete and Resume stayed clickable while the form was open, so a retry could change the data and the form's next save would write its stale values over it.

Fix (`apps/web/src/items/item-view.tsx`): a refusal of the whole edit closes the form, shows the message above the steps and reloads the item, so the next edit starts from the data as it now is; field errors (422) stay in the open form. While the form is open the view's other actions are disabled.

Regression test: `tests/e2e/process.spec.ts`, "an admin corrects a failed item's data in the item view, then retries it" (another admin's edit lands while the form is open; Retry is disabled, the save is refused with "changed since it was read", the form closes and reopens prefilled with the newer data).
