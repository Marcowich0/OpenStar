//! The Party's own rules, free of the task and the database: drawing a Join
//! code and a Party id, and starting a Party.

use openstar_protocol::{JoinCode, PartyId, PartySnapshot, StageId};

/// How many Join codes there are: `0000` to `9999`.
const JOIN_CODES: u16 = 10_000;

/// Starts a Party on `stage_id` at `now_ms`, with a new id and a Join code
/// that differs from the `previous` Party's.
pub fn start_party(
    stage_id: &StageId,
    previous: Option<&PartySnapshot>,
    now_ms: i64,
) -> anyhow::Result<PartySnapshot> {
    Ok(PartySnapshot {
        party_id: draw_party_id()?,
        stage_id: stage_id.clone(),
        join_code: draw_join_code(previous.map(|party| &party.join_code))?,
        started_at_ms: now_ms,
    })
}

/// Four random digits, never equal to `previous`.
pub fn draw_join_code(previous: Option<&JoinCode>) -> anyhow::Result<JoinCode> {
    draw_join_code_from(previous, random_u16)
}

/// [`draw_join_code`] with the randomness handed in, so a test can rig it.
fn draw_join_code_from(
    previous: Option<&JoinCode>,
    mut random: impl FnMut() -> anyhow::Result<u16>,
) -> anyhow::Result<JoinCode> {
    loop {
        // Rejection sampling keeps every code equally likely.
        let value = random()?;
        if value >= u16::MAX - u16::MAX % JOIN_CODES {
            continue;
        }
        let code = JoinCode(format!("{:04}", value % JOIN_CODES));
        if previous != Some(&code) {
            return Ok(code);
        }
    }
}

/// 128 random bits as 32 lowercase hex digits.
fn draw_party_id() -> anyhow::Result<PartyId> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| anyhow::anyhow!("no OS randomness: {error}"))?;
    Ok(PartyId(bytes.iter().map(|b| format!("{b:02x}")).collect()))
}

fn random_u16() -> anyhow::Result<u16> {
    let mut bytes = [0_u8; 2];
    getrandom::fill(&mut bytes).map_err(|error| anyhow::anyhow!("no OS randomness: {error}"))?;
    Ok(u16::from_le_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_four_digits(code: &JoinCode) -> bool {
        code.0.len() == 4 && code.0.chars().all(|c| c.is_ascii_digit())
    }

    #[test]
    fn a_join_code_is_four_random_digits() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..2_000 {
            let code = draw_join_code(None).unwrap();
            assert!(is_four_digits(&code), "{code:?}");
            seen.insert(code);
        }
        // 2 000 draws from 10 000 codes: far more than a handful are distinct.
        assert!(seen.len() > 1_500, "only {} distinct codes", seen.len());
    }

    #[test]
    fn a_new_partys_code_never_equals_the_previous_partys() {
        let mut previous = draw_join_code(None).unwrap();
        for _ in 0..20_000 {
            let next = draw_join_code(Some(&previous)).unwrap();
            assert!(is_four_digits(&next));
            assert_ne!(next, previous);
            previous = next;
        }
    }

    #[test]
    fn a_draw_that_hits_the_previous_code_draws_again() {
        // A source that first yields the previous code (0427), then 1234.
        let mut values = [427_u16, 1234].into_iter();
        let code = draw_join_code_from(Some(&JoinCode("0427".into())), || {
            Ok(values.next().unwrap())
        })
        .unwrap();
        assert_eq!(code, JoinCode("1234".into()));
    }

    #[test]
    fn leading_zeros_are_kept() {
        let code = draw_join_code_from(None, || Ok(7)).unwrap();
        assert_eq!(code, JoinCode("0007".into()));
    }

    #[test]
    fn every_new_party_has_a_new_id_and_the_given_stage_and_time() {
        let stage = StageId("main".into());
        let first = start_party(&stage, None, 1_000).unwrap();
        let second = start_party(&stage, Some(&first), 2_000).unwrap();
        assert_ne!(first.party_id, second.party_id);
        assert_ne!(first.join_code, second.join_code);
        assert_eq!(second.stage_id, stage);
        assert_eq!(second.started_at_ms, 2_000);
    }
}
