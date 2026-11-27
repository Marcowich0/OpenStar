//! Profiles: create, list and edit over HTTP+JSON, by anyone (the routes
//! and their answers are documented in `openstar_protocol::profile`).
//!
//! The name rules are [`check_name`]; uniqueness is checked and the row
//! written in one transaction, and the `name_key` column is `UNIQUE` too.
//! Deleting a Profile belongs to the Admin area: [`delete_profile`] is the
//! guarded endpoint, which deletes through the Party (`LiveHandle::delete_profile`).

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use openstar_protocol::UserMessage;
use openstar_protocol::profile::{
    Avatar, AvatarKey, Difficulty, NAME_MAX_LENGTH, NewProfile, PaletteKey, Profile, ProfileEdit,
    ProfileId,
};
use rusqlite::types::Type;
use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::AppState;
use crate::db::Database;

/// A Profile name that passed the name rules.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CheckedName {
    /// The name as stored and shown: surrounding spaces trimmed.
    pub display: String,
    /// What uniqueness compares: the trimmed name, case-folded.
    pub key: String,
}

/// Applies the name rules shared by create and rename: surrounding spaces
/// are trimmed, and the rest must be 1 to [`NAME_MAX_LENGTH`] characters.
pub(crate) fn check_name(raw: &str) -> Result<CheckedName, UserMessage> {
    let display = raw.trim();
    if display.is_empty() {
        return Err(UserMessage::ProfileNameEmpty);
    }
    if display.chars().count() > NAME_MAX_LENGTH as usize {
        return Err(UserMessage::ProfileNameTooLong {
            max_length: NAME_MAX_LENGTH,
        });
    }
    Ok(CheckedName {
        display: display.to_owned(),
        key: name_key(display),
    })
}

/// What name uniqueness compares, for Profiles and Guests alike: the name
/// without surrounding spaces, case-folded.
pub(crate) fn name_key(name: &str) -> String {
    name.trim().to_lowercase()
}

/// Why a create or edit was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Refused {
    /// The name breaks the name rules.
    Name(UserMessage),
    /// Another Profile holds this name.
    Taken(ProfileId),
    /// No Profile has this id.
    NotFound,
    /// The current Party refuses it: a Guest has the name
    /// ([`UserMessage::NameTakenTonight`]), or the Party is full
    /// ([`UserMessage::PartyFull`]).
    Party(UserMessage),
}

impl IntoResponse for Refused {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Name(message) => (StatusCode::UNPROCESSABLE_ENTITY, message),
            Self::Taken(profile_id) => (
                StatusCode::CONFLICT,
                UserMessage::ProfileNameTaken { profile_id },
            ),
            Self::NotFound => (StatusCode::NOT_FOUND, UserMessage::ProfileNotFound),
            Self::Party(message) => (StatusCode::CONFLICT, message),
        };
        (status, Json(message)).into_response()
    }
}

const COLUMNS: &str = "id, name, avatar_kind, avatar_ref, favourite_colour, \
    last_difficulty, created_ms, last_sung_ms";

/// The stored kind of a built-in avatar; its reference is the avatar key.
const BUILT_IN: &str = "builtIn";

/// Every Profile, in "Who's singing?" order: by last sung, most recent
/// first, then the never-sung ones by name.
pub(crate) async fn list(db: &Database) -> anyhow::Result<Vec<Profile>> {
    db.call(|conn| {
        let mut statement = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM profiles
             ORDER BY last_sung_ms IS NULL, last_sung_ms DESC, name_key, id"
        ))?;
        statement
            .query_map([], read_profile)?
            .collect::<rusqlite::Result<Vec<_>>>()
    })
    .await
}

/// The Profile with this id, if there is one.
pub(crate) async fn get(db: &Database, id: ProfileId) -> anyhow::Result<Option<Profile>> {
    db.call(move |conn| get_in(conn, id)).await
}

/// Creates a Profile at `now` (milliseconds since the Unix epoch): Medium,
/// never sung.
pub(crate) async fn create(
    db: &Database,
    new: NewProfile,
    now: i64,
) -> anyhow::Result<Result<Profile, Refused>> {
    let name = match check_name(&new.name) {
        Ok(name) => name,
        Err(message) => return Ok(Err(Refused::Name(message))),
    };
    db.call(move |conn| {
        let tx = conn.transaction()?;
        let created = create_in(&tx, &name, &new, now)?;
        tx.commit()?;
        Ok(created)
    })
    .await
}

/// [`create`] inside the caller's transaction, with the name already
/// through [`check_name`]; the caller commits.
pub(crate) fn create_in(
    conn: &Connection,
    name: &CheckedName,
    new: &NewProfile,
    now: i64,
) -> rusqlite::Result<Result<Profile, Refused>> {
    if let Some(holder) = name_holder(conn, &name.key, None)? {
        return Ok(Err(Refused::Taken(holder)));
    }
    let (avatar_kind, avatar_ref) = avatar_columns(new.avatar);
    conn.execute(
        "INSERT INTO profiles (name, name_key, avatar_kind, avatar_ref, favourite_colour,
                               last_difficulty, created_ms, last_sung_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
        params![
            name.display,
            name.key,
            avatar_kind,
            avatar_ref,
            new.favourite_colour.as_str(),
            crate::stage_options::read_in(conn)?
                .starting_difficulty
                .as_str(),
            now,
        ],
    )?;
    let id = profile_id(conn.last_insert_rowid(), 0)?;
    get_in(conn, id)?
        .map(Ok)
        .ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// The Profile whose name has the name key `key`, if any.
pub(crate) async fn named(db: &Database, key: String) -> anyhow::Result<Option<ProfileId>> {
    db.call(move |conn| name_holder(conn, &key, None)).await
}

/// Changes the fields `edit` names. A new name follows the create rules; the
/// id stays, so everything keyed by it (Score records) is untouched.
pub(crate) async fn edit(
    db: &Database,
    id: ProfileId,
    edit: ProfileEdit,
) -> anyhow::Result<Result<Profile, Refused>> {
    let name = match edit.name.as_deref().map(check_name).transpose() {
        Ok(name) => name,
        Err(message) => return Ok(Err(Refused::Name(message))),
    };
    db.call(move |conn| {
        let tx = conn.transaction()?;
        let edited = edit_in(&tx, id, name.as_ref(), edit.avatar, edit.favourite_colour)?;
        tx.commit()?;
        Ok(edited)
    })
    .await
}

/// [`edit`] inside the caller's transaction, with the new name already
/// through [`check_name`]; the caller commits.
pub(crate) fn edit_in(
    conn: &Connection,
    id: ProfileId,
    name: Option<&CheckedName>,
    avatar: Option<Avatar>,
    favourite_colour: Option<PaletteKey>,
) -> rusqlite::Result<Result<Profile, Refused>> {
    if get_in(conn, id)?.is_none() {
        return Ok(Err(Refused::NotFound));
    }
    if let Some(name) = name {
        if let Some(holder) = name_holder(conn, &name.key, Some(id))? {
            return Ok(Err(Refused::Taken(holder)));
        }
        conn.execute(
            "UPDATE profiles SET name = ?1, name_key = ?2 WHERE id = ?3",
            params![name.display, name.key, id.0],
        )?;
    }
    if let Some(avatar) = avatar {
        let (avatar_kind, avatar_ref) = avatar_columns(avatar);
        conn.execute(
            "UPDATE profiles SET avatar_kind = ?1, avatar_ref = ?2 WHERE id = ?3",
            params![avatar_kind, avatar_ref, id.0],
        )?;
    }
    if let Some(colour) = favourite_colour {
        conn.execute(
            "UPDATE profiles SET favourite_colour = ?1 WHERE id = ?2",
            params![colour.as_str(), id.0],
        )?;
    }
    get_in(conn, id)?
        .map(Ok)
        .ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// Records that the Profile sang at `at` on `difficulty`: its last sung time
/// and last Difficulty. Storing a Score record calls it inside its
/// transaction; false when no Profile has this id.
pub(crate) fn record_sung_in(
    conn: &Connection,
    id: ProfileId,
    difficulty: Difficulty,
    at: i64,
) -> rusqlite::Result<bool> {
    let changed = conn.execute(
        "UPDATE profiles SET last_difficulty = ?1, last_sung_ms = ?2 WHERE id = ?3",
        params![difficulty.as_str(), at, id.0],
    )?;
    Ok(changed > 0)
}

/// Deletes the Profile in the caller's transaction; its Score records go
/// with it (`ON DELETE CASCADE`). False when no Profile has this id. A
/// Party membership must be gone first: [`crate::live`] deletes through the
/// Party, which removes it in the same transaction.
pub(crate) fn delete_in(conn: &Connection, id: ProfileId) -> rusqlite::Result<bool> {
    Ok(conn.execute("DELETE FROM profiles WHERE id = ?1", [id.0])? > 0)
}

/// Sets the last Difficulty of the Profile, which its next seat starts at
/// ("My Difficulty for the next Song" from a Phone that is not seated).
/// False when no Profile has this id.
pub(crate) async fn set_last_difficulty(
    db: &Database,
    id: ProfileId,
    difficulty: Difficulty,
) -> anyhow::Result<bool> {
    db.call(move |conn| {
        let changed = conn.execute(
            "UPDATE profiles SET last_difficulty = ?1 WHERE id = ?2",
            params![difficulty.as_str(), id.0],
        )?;
        Ok(changed > 0)
    })
    .await
}

/// [`record_sung_in`] on its own.
#[cfg(test)]
async fn record_sung(
    db: &Database,
    id: ProfileId,
    difficulty: Difficulty,
    at: i64,
) -> anyhow::Result<bool> {
    db.call(move |conn| record_sung_in(conn, id, difficulty, at))
        .await
}

pub(crate) fn get_in(conn: &Connection, id: ProfileId) -> rusqlite::Result<Option<Profile>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM profiles WHERE id = ?1"),
        [id.0],
        read_profile,
    )
    .optional()
}

/// The Profile other than `except` whose name has this key.
fn name_holder(
    conn: &Connection,
    key: &str,
    except: Option<ProfileId>,
) -> rusqlite::Result<Option<ProfileId>> {
    let id: Option<i64> = conn
        .query_row(
            "SELECT id FROM profiles WHERE name_key = ?1 AND id IS NOT ?2",
            params![key, except.map(|id| id.0)],
            |row| row.get(0),
        )
        .optional()?;
    id.map(|id| profile_id(id, 0)).transpose()
}

/// How an avatar is stored: its kind and its reference (for a built-in
/// one, the key). Guests are stored the same way.
pub(crate) fn avatar_columns(avatar: Avatar) -> (&'static str, &'static str) {
    match avatar {
        Avatar::BuiltIn { key } => (BUILT_IN, key.as_str()),
    }
}

/// Reads an avatar stored by [`avatar_columns`] from columns `kind_column`
/// and `kind_column + 1` of `row`.
pub(crate) fn read_avatar(row: &Row<'_>, kind_column: usize) -> rusqlite::Result<Avatar> {
    let kind: String = row.get(kind_column)?;
    let reference: String = row.get(kind_column + 1)?;
    match kind.as_str() {
        BUILT_IN => Ok(Avatar::BuiltIn {
            key: AvatarKey::from_key(&reference)
                .ok_or_else(|| unknown(kind_column + 1, "avatar", &reference))?,
        }),
        _ => Err(unknown(kind_column, "avatar kind", &kind)),
    }
}

fn read_profile(row: &Row<'_>) -> rusqlite::Result<Profile> {
    let avatar = read_avatar(row, 2)?;
    let colour: String = row.get(4)?;
    let difficulty: String = row.get(5)?;
    Ok(Profile {
        id: profile_id(row.get(0)?, 0)?,
        name: row.get(1)?,
        avatar,
        favourite_colour: PaletteKey::from_key(&colour)
            .ok_or_else(|| unknown(4, "palette key", &colour))?,
        last_difficulty: Difficulty::from_key(&difficulty)
            .ok_or_else(|| unknown(5, "Difficulty", &difficulty))?,
        created_at: row.get(6)?,
        last_sung_at: row.get(7)?,
    })
}

fn profile_id(id: i64, column: usize) -> rusqlite::Result<ProfileId> {
    u32::try_from(id).map(ProfileId).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(column, Type::Integer, error.into())
    })
}

pub(crate) fn unknown(column: usize, what: &str, value: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        column,
        Type::Text,
        format!("unknown {what} {value:?}").into(),
    )
}

fn internal_error(error: &anyhow::Error) -> Response {
    tracing::error!(?error, "Profiles");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(UserMessage::ServerError),
    )
        .into_response()
}

/// `GET /api/profiles`.
pub(crate) async fn list_profiles(State(state): State<AppState>) -> Response {
    match list(&state.db).await {
        Ok(profiles) => Json(profiles).into_response(),
        Err(error) => internal_error(&error),
    }
}

/// `GET /api/profiles/{id}`.
pub(crate) async fn get_profile(State(state): State<AppState>, Path(id): Path<u32>) -> Response {
    match get(&state.db, ProfileId(id)).await {
        Ok(Some(profile)) => Json(profile).into_response(),
        Ok(None) => Refused::NotFound.into_response(),
        Err(error) => internal_error(&error),
    }
}

/// `POST /api/profiles`.
pub(crate) async fn create_profile(
    State(state): State<AppState>,
    Json(new): Json<NewProfile>,
) -> Response {
    let now = state.clock.now_millis();
    // Through the live-state task: Guest names and a full Party refuse it.
    match state.live.create_profile(new, now).await {
        Ok(Ok(profile)) => (StatusCode::CREATED, Json(profile)).into_response(),
        Ok(Err(refused)) => refused.into_response(),
        Err(error) => internal_error(&error),
    }
}

/// `PATCH /api/profiles/{id}`.
pub(crate) async fn edit_profile(
    State(state): State<AppState>,
    Path(id): Path<u32>,
    Json(changes): Json<ProfileEdit>,
) -> Response {
    // Through the live-state task: a Guest's name refuses a rename. This is
    // the edit outside a Party (any colour; only the favourite changes);
    // inside the Party a Phone uses `ClientMessage::EditMember`.
    match state.live.edit_profile(ProfileId(id), changes).await {
        Ok(Ok(profile)) => Json(profile).into_response(),
        Ok(Err(refused)) => refused.into_response(),
        Err(error) => internal_error(&error),
    }
}

/// `DELETE /api/profiles/{id}` (guarded: it deletes kept data): `204` once the Profile and its Score records are gone, `404
/// profileNotFound`, or `409 profileSinging` while it sings in the playing
/// Song. Through the live-state task: a Party member leaves the Party first.
pub(crate) async fn delete_profile(State(state): State<AppState>, Path(id): Path<u32>) -> Response {
    match state.live.delete_profile(ProfileId(id)).await {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(refused)) => refused.into_response(),
        Err(error) => internal_error(&error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new(name: &str) -> NewProfile {
        NewProfile {
            name: name.to_owned(),
            avatar: Avatar::BuiltIn {
                key: AvatarKey::Star,
            },
            favourite_colour: PaletteKey::Cherry,
        }
    }

    async fn names(db: &Database) -> Vec<String> {
        list(db)
            .await
            .unwrap()
            .into_iter()
            .map(|p| p.name)
            .collect()
    }

    #[tokio::test]
    async fn the_list_is_last_sung_first_then_never_sung_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).await.unwrap().database;
        let mut ids = std::collections::HashMap::new();
        for name in ["zoe", "Ann", "bo", "Cleo", "Dan"] {
            let profile = create(&db, new(name), 1).await.unwrap().unwrap();
            ids.insert(name, profile.id);
        }
        assert_eq!(names(&db).await, ["Ann", "bo", "Cleo", "Dan", "zoe"]);

        assert!(
            record_sung(&db, ids["Dan"], Difficulty::Hard, 100)
                .await
                .unwrap()
        );
        assert!(
            record_sung(&db, ids["zoe"], Difficulty::Easy, 300)
                .await
                .unwrap()
        );
        assert!(
            record_sung(&db, ids["Cleo"], Difficulty::Medium, 200)
                .await
                .unwrap()
        );
        assert_eq!(names(&db).await, ["zoe", "Cleo", "Dan", "Ann", "bo"]);

        let zoe = get(&db, ids["zoe"]).await.unwrap().unwrap();
        assert_eq!(zoe.last_difficulty, Difficulty::Easy);
        assert_eq!(zoe.last_sung_at, Some(300));
        assert!(
            !record_sung(&db, ProfileId(999), Difficulty::Easy, 1)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn a_rename_keeps_what_is_keyed_by_the_profile_id() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).await.unwrap().database;
        let bo = create(&db, new("Bo"), 1).await.unwrap().unwrap();
        record_sung(&db, bo.id, Difficulty::Hard, 50).await.unwrap();
        let renamed = edit(
            &db,
            bo.id,
            ProfileEdit {
                name: Some("Bodil".into()),
                ..ProfileEdit::default()
            },
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(renamed.id, bo.id);
        assert_eq!(renamed.last_difficulty, Difficulty::Hard);
        assert_eq!(renamed.last_sung_at, Some(50));
    }

    #[test]
    fn surrounding_spaces_are_trimmed_and_case_is_ignored_for_uniqueness() {
        let a = check_name("  Bo ").unwrap();
        let b = check_name("bO").unwrap();
        assert_eq!(a.display, "Bo");
        assert_eq!(b.display, "bO");
        assert_eq!(a.key, b.key);
        assert_ne!(check_name("Bo Bo").unwrap().key, a.key);
    }

    #[test]
    fn a_name_has_at_most_16_characters_after_trimming() {
        assert_eq!(
            check_name("Sixteen chars ok").unwrap().display,
            "Sixteen chars ok"
        );
        assert_eq!(
            check_name("  Sixteen chars ok  ").unwrap().display,
            "Sixteen chars ok"
        );
        assert_eq!(
            check_name("Seventeen chars!!"),
            Err(UserMessage::ProfileNameTooLong { max_length: 16 })
        );
        // Characters, not bytes: sixteen two-byte letters fit.
        assert!(check_name(&"ø".repeat(16)).is_ok());
        assert!(check_name(&"ø".repeat(17)).is_err());
    }

    #[test]
    fn a_name_of_only_spaces_is_refused() {
        assert_eq!(check_name("   "), Err(UserMessage::ProfileNameEmpty));
        assert_eq!(check_name(""), Err(UserMessage::ProfileNameEmpty));
    }
}
