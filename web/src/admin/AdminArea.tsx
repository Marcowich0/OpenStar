import { Link, Outlet } from "@tanstack/react-router";

/** `/admin`: the Admin area and its four sections. A placeholder for now. */
export function AdminArea() {
  return (
    <main>
      <h1>Admin</h1>
      <nav>
        <Link to="/admin/downloads">Downloads</Link>{" "}
        <Link to="/admin/songs">Songs</Link>{" "}
        <Link to="/admin/library-problems">Library problems</Link>{" "}
        <Link to="/admin/profiles">Profiles</Link>
      </nav>
      <Outlet />
    </main>
  );
}
