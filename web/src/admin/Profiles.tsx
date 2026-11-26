// The Admin area's Profiles section (v1 spec #48, "Profiles"; #45): every
// Profile with its avatar, name and last sung, refreshed by the `profiles`
// change notice. It is the only place a Profile is deleted: a guarded action
// (it deletes kept data, the Profile's Score records with it) confirmed by a
// press and hold. Without an Unlock the Admin PIN pad comes first.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, ApiFailure, type Refusal } from "../api/api";
import { profilesQuery } from "../api/queries";
import type { ApiError } from "../generated/ApiError";
import type { ApiErrorCode } from "../generated/ApiErrorCode";
import type { Profile } from "../generated/Profile";
import { useGuardedAction } from "../guarded/useGuardedAction";
import { apiErrorText, userMessageText } from "../i18n/serverText";
import { t } from "../i18n/t";
import { Avatar } from "../ui/Avatar";
import { HoldButton } from "../ui/HoldButton";
import { AdminSection } from "./AdminSection";

// The catalogue's language, as `t` formats numbers in it.
const LAST_SUNG = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

export function Profiles() {
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
                <AdminProfileRow key={profile.id} profile={profile} />
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

// The guard's and the PIN's codes; any other refusal is a `UserMessage`.
const API_ERROR_CODES = {
  wrongPin: true,
  unlockRequired: true,
  libraryReadOnly: true,
  stagePinRequired: true,
} as const satisfies Record<ApiErrorCode, true>;

function isApiError(refusal: Refusal): refusal is ApiError {
  return Object.hasOwn(API_ERROR_CODES, refusal.code);
}

function problemText(problem: Problem): string {
  if (problem.kind === "failed") return t("admin.profiles.deleteFailed");
  return isApiError(problem.refusal)
    ? apiErrorText(problem.refusal)
    : userMessageText(problem.refusal);
}

/** One Profile: its avatar, name and last sung, and Delete (press and hold). */
function AdminProfileRow({ profile }: { profile: Profile }) {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<Problem | null>(null);
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
      {remove.dialog}
    </li>
  );
}
