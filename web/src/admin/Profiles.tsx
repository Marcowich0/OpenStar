// The Admin area's Profiles section (v1 spec #48, "Profiles"; #45): every
// Profile with its avatar, name and last sung, refreshed by the `profiles`
// change notice. Edit opens the Phone's "Change name, look or colour" form
// under the row (not guarded: anyone may edit any Profile, spec #244). It is
// the only place a Profile is deleted: a guarded action (it deletes kept
// data, the Profile's Score records with it) confirmed by a press and hold.
// Without an Unlock the Admin PIN pad comes first.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import { api, ApiFailure, type Refusal } from "../api/api";
import { profilesQuery } from "../api/queries";
import type { Profile } from "../generated/Profile";
import type { ProfileEdit } from "../generated/ProfileEdit";
import type { UserMessage } from "../generated/UserMessage";
import { useGuardedAction } from "../guarded/useGuardedAction";
import { userMessageText } from "../i18n/serverText";
import { t } from "../i18n/t";
import type { LiveStore } from "../live/liveStore";
import { liveStore } from "../live/useLive";
import { LookForm } from "../phone/LookForm";
import { Avatar } from "../ui/Avatar";
import { HoldButton } from "../ui/HoldButton";
import { AdminSection } from "./AdminSection";

// The catalogue's language, as `t` formats numbers in it.
const LAST_SUNG = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

export function Profiles({
  store = liveStore(),
}: {
  /** The live state the edit form checks tonight's Guest names against. */
  store?: LiveStore;
} = {}) {
  const list = useQuery(profilesQuery);

  return (
    <AdminSection title={t("admin.profiles")}>
      <div className="flex flex-col gap-4">
        <p>{t("admin.profiles.intro")}</p>
        {list.data ? (
          list.data.length === 0 ? (
            <p className="py-4 text-center">{t("admin.profiles.empty")}</p>
          ) : (
            <ul
              aria-label={t("admin.profiles.list")}
              // Room under each row for the hold's "Hold for a moment" hint.
              className="flex flex-col gap-8"
            >
              {list.data.map((profile) => (
                <AdminProfileRow
                  key={profile.id}
                  profile={profile}
                  store={store}
                />
              ))}
            </ul>
          )
        ) : (
          <p role="status" className="py-4 text-center">
            {t(
              list.isError ? "admin.profiles.failed" : "admin.profiles.loading",
            )}
          </p>
        )}
      </div>
    </AdminSection>
  );
}

/** What a failed delete shows on its row. */
type Problem = { kind: "refused"; refusal: Refusal } | { kind: "failed" };

function problemOf(error: unknown): Problem {
  return error instanceof ApiFailure && error.failure.kind === "refused"
    ? { kind: "refused", refusal: error.failure.error }
    : { kind: "failed" };
}

function problemText(problem: Problem): string {
  if (problem.kind === "failed") return t("admin.profiles.deleteFailed");
  return userMessageText(problem.refusal);
}

/** What opens under a Profile's row; `null` while it is just the row. */
type RowPanel = "edit" | null;

/**
 * Saves an Admin edit; resolves to a problem to show, or `null` once saved
 * (the `profiles` notice refreshes every list and every Phone showing it).
 */
async function saveProfile(
  profile: Profile,
  edit: ProfileEdit,
): Promise<UserMessage | null> {
  try {
    await api("PATCH /api/profiles/{id}", {
      params: { id: String(profile.id) },
      body: edit,
    });
    return null;
  } catch (error: unknown) {
    const problem = problemOf(error);
    return problem.kind === "refused"
      ? problem.refusal
      : { code: "serverError" };
  }
}

/**
 * One Profile: its avatar, name and last sung, Edit, and Delete (press and
 * hold); under it, the panel Edit opens.
 */
function AdminProfileRow({
  profile,
  store,
}: {
  profile: Profile;
  store: LiveStore;
}) {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<Problem | null>(null);
  const [panel, setPanel] = useState<RowPanel>(null);
  const panelId = useId();
  const remove = useGuardedAction(() =>
    api("DELETE /api/profiles/{id}", { params: { id: String(profile.id) } }),
  );

  function onHold() {
    setProblem(null);
    remove.run().then(
      (outcome) => {
        // The `profiles` notice refreshes every list; this one need not wait.
        if (outcome.kind === "done")
          void queryClient.invalidateQueries(profilesQuery);
      },
      (error: unknown) => {
        setProblem(problemOf(error));
      },
    );
  }

  return (
    <li className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-3">
        <span aria-hidden="true" className="flex shrink-0">
          <Avatar
            name={profile.name}
            avatar={profile.avatar}
            colour={profile.favouriteColour}
            size={48}
          />
        </span>
        <div className="flex min-w-0 grow flex-col gap-0.5">
          <span className="truncate text-lg leading-tight font-semibold text-ink">
            {profile.name}
          </span>
          <span className="text-sm text-ink-2">
            {profile.lastSungAt === null
              ? t("admin.profiles.neverSung")
              : t("admin.profiles.lastSung", {
                  date: LAST_SUNG.format(profile.lastSungAt),
                })}
          </span>
        </div>
        <button
          type="button"
          aria-label={t("admin.profiles.edit", { name: profile.name })}
          aria-expanded={panel === "edit"}
          aria-controls={panel === "edit" ? panelId : undefined}
          // The small HoldButton's size, in the white fill.
          className="min-h-12 min-w-12 shrink-0 cursor-pointer rounded-full bg-white px-4 text-xl font-semibold text-ink shadow-ledge outline-none focus-visible:outline-6 focus-visible:outline-yellow"
          onClick={() => {
            setPanel(panel === "edit" ? null : "edit");
          }}
        >
          {t(
            panel === "edit"
              ? "admin.profiles.editClose"
              : "admin.profiles.editShort",
          )}
        </button>
        <HoldButton
          fill="red"
          size="small"
          aria-label={t("admin.profiles.delete", { name: profile.name })}
          onHold={onHold}
          // As wide as the hint under it, so the hint stays on the row.
          className="w-36 shrink-0"
        >
          {t("admin.profiles.deleteShort")}
        </HoldButton>
      </div>
      {problem ? (
        <p role="alert" className="font-semibold text-red">
          {problemText(problem)}
        </p>
      ) : null}
      {panel === "edit" ? (
        <div id={panelId} className="rounded-card-sm bg-cream p-4">
          <LookForm
            kind="profile"
            level={3}
            title={t("admin.profiles.editTitle", { name: profile.name })}
            store={store}
            profile={profile}
            onSave={async (edit) => {
              const refusal = await saveProfile(profile, edit);
              if (refusal === null) {
                void queryClient.invalidateQueries(profilesQuery);
                setPanel(null);
              }
              return refusal;
            }}
          />
        </div>
      ) : null}
      {remove.dialog}
    </li>
  );
}
