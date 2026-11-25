import { describe, expect, it } from "vitest";

import type { ClientMessage } from "../generated/ClientMessage";
import type { PartySnapshot } from "../generated/PartySnapshot";
import type { ServerMessage } from "../generated/ServerMessage";
import type { LiveClientOptions } from "../live/liveClient";
import { createLiveStore } from "../live/liveStore";
import { checkJoinCode, editMemberColour, joinParty } from "./joinRequests";

function fakeServer() {
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  const sent: ClientMessage[] = [];
  let open = true;
  const store = createLiveStore((given) => {
    handlers = given;
    return {
      send: (message) => {
        if (!open) return false;
        sent.push(message);
        return true;
      },
      close: () => {},
    };
  });
  const fake = {
    store,
    sent,
    closeSocket: () => {
      open = false;
    },
    server: (message: ServerMessage) => handlers?.onMessage(message),
    connection: (c: "open" | "reconnecting") => handlers?.onConnection(c),
  };
  fake.connection("open");
  return fake;
}

const party = (memberIds: number[]): PartySnapshot => ({
  partyId: "p1",
  stageId: "main",
  joinCode: "4821",
  startedAtMs: 1,
  members: memberIds.map((memberId) => ({
    memberId,
    identity: { kind: "profile", profileId: 7 },
    colour: "sky",
    favouriteTaken: false,
    onPhone: true,
  })),
  phones: [],
  queue: [],
  head: null,
  lineUp: null,
});

describe("checking a Join code", () => {
  it("asks the server and is accepted when it confirms the code", async () => {
    const { store, sent, server } = fakeServer();
    const answer = checkJoinCode(store, "4821");
    expect(sent).toEqual([{ type: "checkJoinCode", joinCode: "4821" }]);
    server({ type: "joinCodeValid", joinCode: "4821" });
    await expect(answer).resolves.toBe("accepted");
  });

  it("is refused when the server says the code is wrong", async () => {
    const { store, server } = fakeServer();
    const answer = checkJoinCode(store, "1111");
    server({ type: "rejected", reason: { code: "joinCodeWrong" } });
    await expect(answer).resolves.toBe("refused");
  });

  it("is refused again for a second wrong code", async () => {
    const { store, server } = fakeServer();
    const first = checkJoinCode(store, "1111");
    server({ type: "rejected", reason: { code: "joinCodeWrong" } });
    await first;
    const second = checkJoinCode(store, "2222");
    server({ type: "rejected", reason: { code: "joinCodeWrong" } });
    await expect(second).resolves.toBe("refused");
  });

  it("is unanswered when the socket is closed or drops", async () => {
    const { store, closeSocket, connection } = fakeServer();
    const dropped = checkJoinCode(store, "4821");
    connection("reconnecting");
    await expect(dropped).resolves.toBe("unanswered");
    closeSocket();
    await expect(checkJoinCode(store, "4821")).resolves.toBe("unanswered");
  });
});

describe("joining the Party as a Profile", () => {
  it("sends the Phone id, code and Profile, and succeeds once the Phone is a member", async () => {
    const { store, sent, server } = fakeServer();
    server({
      type: "liveState",
      stageId: "main",
      party: party([]),
      isStage: false,
    });
    const joined = joinParty(store, {
      phoneId: "phone-a",
      joinCode: "4821",
      joinAs: { kind: "profile", profileId: 7 },
    });
    expect(sent).toEqual([
      {
        type: "join",
        phoneId: "phone-a",
        joinCode: "4821",
        joinAs: { kind: "profile", profileId: 7 },
      },
    ]);
    server({ type: "phoneStatus", memberId: 1 });
    server({
      type: "partyChanged",
      party: party([1]),
      change: {
        actor: { kind: "member", memberId: 1 },
        event: {
          code: "memberJoined",
          params: { memberId: 1, name: "Bo", colour: "sky" },
        },
      },
    });
    await expect(joined).resolves.toEqual({
      ok: true,
      member: expect.objectContaining({ memberId: 1 }) as unknown,
    });
  });

  it("fails with the server's reason", async () => {
    const { store, server } = fakeServer();
    const joined = joinParty(store, {
      phoneId: "phone-a",
      joinCode: "4821",
      joinAs: { kind: "profile", profileId: 7 },
    });
    server({ type: "rejected", reason: { code: "partyFull" } });
    await expect(joined).resolves.toEqual({
      ok: false,
      reason: { code: "partyFull" },
    });
  });
});

describe("changing a member's colour", () => {
  const withColour = (colour: "sky" | "mint"): PartySnapshot => ({
    ...party([]),
    members: party([1]).members.map((m) => ({ ...m, colour })),
  });

  it("sends the edit and succeeds once the member has the colour", async () => {
    const { store, sent, server } = fakeServer();
    server({
      type: "liveState",
      stageId: "main",
      party: withColour("sky"),
      isStage: false,
    });
    const changed = editMemberColour(store, 1, "mint");
    expect(sent).toEqual([
      { type: "editMember", memberId: 1, edit: { colour: "mint" } },
    ]);
    server({
      type: "liveState",
      stageId: "main",
      party: withColour("mint"),
      isStage: false,
    });
    await expect(changed).resolves.toEqual({ ok: true });
  });

  it("fails with the server's reason", async () => {
    const { store, server } = fakeServer();
    server({
      type: "liveState",
      stageId: "main",
      party: withColour("sky"),
      isStage: false,
    });
    const changed = editMemberColour(store, 1, "mint");
    server({ type: "rejected", reason: { code: "colourTaken" } });
    await expect(changed).resolves.toEqual({
      ok: false,
      reason: { code: "colourTaken" },
    });
  });
});
