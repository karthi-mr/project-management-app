"""@mentions in chat: a mentioned member is notified; @all in a group notifies every member."""
from conftest import ok


def mentions_for(person):
    return [n for n in ok(person.api.get("/api/notifications"))["updates"] if n["conversation_id"]]


def group(ws, *people, name="Launch team"):
    return ok(ws.admin.api.post("/api/chat/groups", {"name": name, "member_ids": [p.id for p in people]}), 201)


def say(person, conv, body):
    return ok(person.api.post(f"/api/chat/conversations/{conv['id']}/messages", {"body": body}), 201)


def test_a_mention_notifies_only_that_member(workspace):
    ws = workspace()
    dana, sam, outsider = ws.add_person(full_name="Dana Lee"), ws.add_person(full_name="Sam Carter"), ws.add_person()
    conv = group(ws, dana, sam)
    message = say(dana, conv, f"@{sam.username} can you check the build? cc @{outsider.username} @nobody")
    assert message["mentions"] == [sam.id] and message["mentions_all"] is False
    notes = mentions_for(sam)
    assert len(notes) == 1 and notes[0]["conversation_id"] == conv["id"]
    assert notes[0]["message"].startswith("Dana Lee mentioned you in Launch team: “@")
    assert mentions_for(ws.admin) == [] and mentions_for(outsider) == []  # not a member of the group
    row = next(c for c in ok(sam.api.get("/api/chat/conversations")) if c["id"] == conv["id"])
    assert row["mentions"] == 1 and row["unread"] >= 1  # the group also opens with a system message
    ok(sam.api.get(f"/api/chat/conversations/{conv['id']}/messages"))  # reading clears it
    assert next(c for c in ok(sam.api.get("/api/chat/conversations")) if c["id"] == conv["id"])["mentions"] == 0


def test_at_all_notifies_every_member_except_the_sender(workspace):
    ws = workspace()
    dana, sam = ws.add_person(full_name="Dana Lee"), ws.add_person(full_name="Sam Carter")
    conv = group(ws, dana, sam)
    message = say(dana, conv, f"@all standup in 5 minutes, @{sam.username} please share your screen")
    assert message["mentions_all"] is True
    assert [n["message"].split(" in ")[0] for n in mentions_for(ws.admin)] == ["Dana Lee mentioned everyone"]
    assert [n["message"].split(" in ")[0] for n in mentions_for(sam)] == ["Dana Lee mentioned you"]  # once, not twice
    assert mentions_for(dana) == []
    assert next(c for c in ok(ws.admin.api.get("/api/chat/conversations")) if c["id"] == conv["id"])["mentions"] == 1


def test_at_all_means_nothing_in_a_direct_chat_and_emails_are_not_mentions(workspace):
    ws = workspace()
    dana = ws.add_person(full_name="Dana Lee")
    direct = ok(ws.admin.api.post("/api/chat/direct", {"user_id": dana.id}))
    message = say(ws.admin, direct, f"@all hi, write to someone@{dana.username}.com")
    assert message["mentions_all"] is False and message["mentions"] == []
    say(ws.admin, direct, f"@{dana.username} hi")
    assert len(mentions_for(dana)) == 1


def test_issue_keys_can_be_looked_up(workspace):
    ws, other = workspace(), workspace()
    project = ws.project("CHT")
    issue = ok(ws.admin.api.post("/api/issues", {"project_id": project["id"], "title": "Broken login"}), 201)
    found = ok(ws.admin.api.get(f"/api/issues/key/{issue['key'].lower()}"))
    assert found["id"] == issue["id"]
    assert other.admin.api.get(f"/api/issues/key/{issue['key']}").status_code == 404
    assert ws.admin.api.get("/api/issues/key/NOPE-1").status_code == 404
