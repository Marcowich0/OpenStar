// The route view of `/admin/songs/<id>/timing`: the Song's Timing editor.

import { getRouteApi } from "@tanstack/react-router";

import { TimingEditor } from "./TimingEditor";

const route = getRouteApi("/admin/songs/$song/timing");

export function TimingEditorPage() {
  const { song } = route.useParams();
  return <TimingEditor key={song} song={song} />;
}
