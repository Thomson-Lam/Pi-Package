local root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p:h:h:h")
package.path = root .. "/nvim/lua/?.lua;" .. root .. "/nvim/lua/?/init.lua;" .. package.path

local state = require("blink.state")
local ui = require("blink.ui")

local function eq(actual, expected, message)
  if not vim.deep_equal(actual, expected) then
    error((message or "not equal") .. "\nactual: " .. vim.inspect(actual) .. "\nexpected: " .. vim.inspect(expected))
  end
end

local function press(keys)
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes(keys, true, false, true), "x", false)
end

local model = state.new("review", "blitz")
state.replace(model, {
  mode = "blitz",
  versions = {
    { versionId = 2, fileId = "f", displayPath = "a.txt", snapshotPath = "/tmp/2", originKind = "file", originSnapshotPath = "/tmp/o" },
    { versionId = 1, fileId = "f", displayPath = "a.txt", snapshotPath = "/tmp/1", originKind = "file", originSnapshotPath = "/tmp/o" },
  },
})
eq(vim.tbl_map(function(v) return v.versionId end, model.versions), { 2 }, "snapshot keeps only the latest version per file")
eq(model.activeVersionId, 2, "latest replayed version is active")
state.toggle_pin(model)
local added = state.upsert(model, { versionId = 3, fileId = "f", displayPath = "a.txt", snapshotPath = "/tmp/3", originKind = "file", originSnapshotPath = "/tmp/o" }, 2)
eq(added.versionId, 3, "same-file upsert replaces retained metadata")
eq(model.activeVersionId, 3, "replacement of active file follows the new version")
eq(vim.tbl_map(function(v) return v.versionId end, model.versions), { 3 })
state.upsert(model, { versionId = 4, fileId = "g", displayPath = "b.txt", snapshotPath = "/tmp/4", originKind = "absent" }, nil)
eq(model.activeVersionId, 3, "another file does not replace the active view")
eq(model.by_id[4].unread, true, "inactive incoming file is unread")
eq(state.navigate_global(model, 3, 1).versionId, 4, "global navigation crosses files")
eq(state.navigate_global(model, 3, 2).versionId, 3, "global navigation supports counted deltas")
eq(state.navigate_edge(model, "first").versionId, 3, "first edge selects oldest retained file")
eq(state.navigate_edge(model, "last").versionId, 4, "last edge selects latest retained file")

local tmp = vim.fn.tempname()
vim.fn.mkdir(tmp, "p")
local origin = tmp .. "/origin"
local version = tmp .. "/version"
vim.fn.writefile({ "A", "B", "C", "D", "E", "F" }, origin, "b")
vim.fn.writefile({ "A", "B changed", "C", "D", "E", "F", "G" }, version, "b")

local sent = {}
local review = ui.new({
  runtime_dir = tmp,
  send = function(message) table.insert(sent, message) end,
})
local item = {
  versionId = 7,
  fileId = "f",
  displayPath = "working/a.txt",
  snapshotPath = version,
  originKind = "file",
  originSnapshotPath = origin,
  firstChangedLine = 2,
}
local buf = review:show_version(item)
eq(vim.bo[buf].buftype, "nofile")
eq(vim.bo[buf].buflisted, true)
eq(vim.bo[buf].modifiable, false)
eq(vim.bo[buf].readonly, true)
assert(vim.api.nvim_buf_get_name(buf):match("^blink://working/a.txt@7$"))
eq(vim.api.nvim_buf_get_lines(buf, 0, -1, false), { "A", "B changed", "C", "D", "E", "F", "G" })
assert(vim.api.nvim_buf_get_name(buf) ~= version, "working/snapshot path must not be buffer name")
local hunks = review:get_hunks(buf)
eq(#hunks, 2, "replacement plus addition hunks")
local counter_marks = vim.tbl_filter(function(mark)
  return mark[4].virt_text_pos == "right_align" and mark[4].virt_text ~= nil
end, vim.api.nvim_buf_get_extmarks(buf, review.namespace, 0, -1, { details = true }))
eq(#counter_marks, 2, "one right-aligned counter per hunk")
eq(counter_marks[1][4].virt_text[1][1], "[1/2]")
eq(counter_marks[2][4].virt_text[1][1], "[2/2]")
press("]c")
eq(vim.api.nvim_win_get_cursor(0)[1], hunks[2][3], "]c mapping moves to the next counted hunk")
eq(review.buffer_state[buf].active_hunk, 2, "hunk counter tracks forward navigation")
press("[c")
eq(vim.api.nvim_win_get_cursor(0)[1], hunks[1][3], "[c mapping moves to the previous hunk")
eq(review.buffer_state[buf].active_hunk, 1, "hunk counter tracks reverse navigation")
press("[c")
eq(vim.api.nvim_win_get_cursor(0)[1], hunks[2][3], "[c wraps from the first hunk to the last")
press("2]c")
eq(vim.api.nvim_win_get_cursor(0)[1], hunks[2][3], "counted ]c applies repeated wrapped navigation")
press("[C")
eq(vim.api.nvim_win_get_cursor(0)[1], hunks[1][3], "[C moves to the first hunk")
eq(review.buffer_state[buf].active_hunk, 1, "first-hunk navigation updates the counter")
press("]C")
eq(vim.api.nvim_win_get_cursor(0)[1], hunks[2][3], "]C moves to the last hunk")
eq(review.buffer_state[buf].active_hunk, 2, "last-hunk navigation updates the counter")

local function check_short_hunk_target(count, expected)
  local path = tmp .. "/short-" .. count
  local lines = {}
  for line = 1, count do lines[line] = "line " .. line end
  vim.fn.writefile(lines, path, "b")
  review:show_version({
    versionId = 700 + count,
    fileId = "short-" .. count,
    displayPath = "short-" .. count .. ".txt",
    snapshotPath = path,
    originKind = "absent",
    firstChangedLine = 1,
  })
  press("]c")
  eq(vim.api.nvim_win_get_cursor(0)[1], expected, count .. "-line hunk navigation target")
end
check_short_hunk_target(4, 2)
check_short_hunk_target(19, 10)
check_short_hunk_target(20, 1)
local deletion_notice
local notify_before_deletion = vim.notify
vim.notify = function(message) deletion_notice = message end
review:navigate_deletion(1, 1)
vim.notify = notify_before_deletion
eq(deletion_notice, "No Blink deletions.", "addition-only buffers report that no deletions exist")
local short_data = review.buffer_state[buf]
short_data.hunks = { { 1, 0, 1, 5 }, { 1, 0, 11, 5 } }
review:_jump_to_hunk(buf, short_data, 1)
review:navigate_hunk(-1, 1)
eq(vim.api.nvim_win_get_cursor(0)[1], 13, "reverse navigation compares midpoint targets and reaches the previous hunk")

local deletion_origin = tmp .. "/deletion-origin"
local deletion_version = tmp .. "/deletion-version"
vim.fn.writefile({ "A", "delete one", "B", "replace old 1", "replace old 2", "C", "D", "delete two", "E" }, deletion_origin, "b")
vim.fn.writefile({ "A", "B", "replace new", "C", "added only", "D", "E" }, deletion_version, "b")
review:show_version({
  versionId = 800,
  fileId = "deletions",
  displayPath = "deletions.txt",
  snapshotPath = deletion_version,
  originKind = "file",
  originSnapshotPath = deletion_origin,
  firstChangedLine = 1,
})
local deletion_hunks = review:get_hunks(buf)
eq(#deletion_hunks, 4, "deletion fixture includes deletion, replacement, addition, and another deletion hunk")
eq(deletion_hunks[3][2], 0, "addition-only hunk has no deleted lines")
press("]d")
eq(vim.api.nvim_win_get_cursor(0)[1], 3, "]d reaches the next replacement hunk")
eq(review.buffer_state[buf].active_hunk, 2, "]d selects the replacement hunk")
press("]d")
eq(vim.api.nvim_win_get_cursor(0)[1], 6, "]d skips addition-only hunks and reaches the final deletion")
eq(review.buffer_state[buf].active_hunk, 4, "]d tracks the final deletion hunk")
press("]d")
eq(vim.api.nvim_win_get_cursor(0)[1], 1, "]d wraps to the first deletion")
press("[d")
eq(vim.api.nvim_win_get_cursor(0)[1], 6, "[d wraps to the last deletion")
press("2[d")
eq(vim.api.nvim_win_get_cursor(0)[1], 1, "counted [d navigates only deletion hunks")
press("]D")
eq(vim.api.nvim_win_get_cursor(0)[1], 6, "]D reaches the last deletion")
press("[D")
eq(vim.api.nvim_win_get_cursor(0)[1], 1, "[D reaches the first deletion")
review:show_version(item)
hunks = review:get_hunks(buf)

local marks_before = #vim.api.nvim_buf_get_extmarks(buf, review.namespace, 0, -1, {})
review:render(buf)
local marks_after = #vim.api.nvim_buf_get_extmarks(buf, review.namespace, 0, -1, {})
eq(marks_after, marks_before, "rerender replaces extmarks")
assert(marks_after > 0, "expected diff extmarks")

local absent = tmp .. "/new"
vim.fn.writefile({ "one", "two" }, absent, "b")
local newbuf = review:show_version({
  versionId = 8,
  fileId = "new",
  absolutePath = tmp .. "/new.txt",
  displayPath = "new.txt",
  snapshotPath = absent,
  originKind = "absent",
  firstChangedLine = 1,
})
eq(newbuf, buf, "all review versions reuse one primary buffer")
eq(vim.b[newbuf].blink_file_id, "new", "reused buffer identity is refreshed")
eq(vim.b[newbuf].blink_absolute_path, tmp .. "/new.txt", "reused buffer path identity is refreshed")
eq(#review:get_hunks(newbuf), 1)
local h = review:get_hunks(newbuf)[1]
eq({ h[1], h[2], h[3], h[4] }, { 1, 0, 1, 2 }, "absent origin is additions-only")

local reused = review:show_version(item)
eq(reused, buf, "returning to a reviewed file keeps the primary buffer")
press("]c")
eq(vim.api.nvim_win_get_cursor(0)[1], review:get_hunks(buf)[2][3], "]c resolves refreshed state after primary-buffer reuse")

local eof_origin = tmp .. "/eof-origin"
local eof_version = tmp .. "/eof-version"
vim.fn.writefile({ "keep", "delete" }, eof_origin)
vim.fn.writefile({ "keep" }, eof_version)
local eof_buf = review:show_version({ versionId = 9, fileId = "eof", absolutePath = tmp .. "/eof.txt", displayPath = "eof.txt", snapshotPath = eof_version, originKind = "file", originSnapshotPath = eof_origin })
eq(eof_buf, buf, "different files also reuse the primary review buffer")
local eof_marks = vim.api.nvim_buf_get_extmarks(eof_buf, review.namespace, 0, -1, { details = true })
local found_eof_deletion = false
for _, mark in ipairs(eof_marks) do
  if mark[4].virt_lines and mark[4].virt_lines_above == false then found_eof_deletion = true end
end
assert(found_eof_deletion, "EOF deletion must render after the final surviving line: hunks=" .. vim.inspect(review:get_hunks(eof_buf)) .. " marks=" .. vim.inspect(eof_marks))
press("]d")
eq(vim.api.nvim_win_get_cursor(0)[1], 1, "EOF deletion navigation stays on the final surviving line")

local rogue = vim.api.nvim_create_buf(true, true)
vim.api.nvim_buf_set_name(rogue, "blink://eof.txt@stale")
vim.b[rogue].blink_owned = true
vim.b[rogue].blink_role = "review"
local original_delete = vim.api.nvim_buf_delete
vim.api.nvim_buf_delete = function(candidate, options)
  if candidate == rogue then error("injected delete failure") end
  return original_delete(candidate, options)
end
review:_sweep_review_buffers(buf)
eq(vim.api.nvim_buf_is_valid(rogue), true, "failed deletion leaves the stale buffer valid")
eq(vim.b[rogue].blink_role, "review", "failed deletion keeps ownership metadata for retry")
vim.api.nvim_buf_delete = original_delete
review:show_version({ versionId = 9, fileId = "eof", absolutePath = tmp .. "/eof.txt", displayPath = "eof.txt", snapshotPath = eof_version, originKind = "file", originSnapshotPath = eof_origin })
eq(vim.api.nvim_buf_is_valid(rogue), false, "untracked stale Blink review buffers are swept on retry")
local live_review_buffers = vim.tbl_filter(function(candidate)
  return vim.api.nvim_buf_is_valid(candidate) and vim.b[candidate].blink_role == "review"
end, vim.api.nvim_list_bufs())
eq(#live_review_buffers, 1, "exactly one primary review buffer remains live")
for version_id = 10, 159 do
  local reused = review:show_version({
    versionId = version_id,
    fileId = "stress-" .. version_id,
    absolutePath = tmp .. "/stress-" .. version_id .. ".txt",
    displayPath = "stress-" .. version_id .. ".txt",
    snapshotPath = eof_version,
    originKind = "file",
    originSnapshotPath = eof_origin,
  })
  eq(reused, buf, "stress navigation reuses the primary buffer")
end
live_review_buffers = vim.tbl_filter(function(candidate)
  return vim.api.nvim_buf_is_valid(candidate) and vim.b[candidate].blink_role == "review"
end, vim.api.nvim_list_bufs())
eq(#live_review_buffers, 1, "150 navigations still leave one live primary review buffer")

local function map_desc(lhs)
  for _, map in ipairs(vim.api.nvim_buf_get_keymap(buf, "n")) do
    if map.lhs == lhs then return map.desc end
  end
end
vim.keymap.set("n", "]c", function() end, { buffer = buf, desc = "Next Class Start" })
vim.api.nvim_exec_autocmds("User", { pattern = "VeryLazy" })
vim.wait(100, function() return map_desc("]c") == "Blink next change" end)
eq(map_desc("]c"), "Blink next change", "Blink reclaims mappings after VeryLazy plugin attachment")
vim.api.nvim_create_autocmd("FileType", {
  buffer = buf,
  callback = function() vim.keymap.set("n", "[c", function() end, { buffer = buf, desc = "Prev Class Start" }) end,
})
vim.api.nvim_exec_autocmds("FileType", { buffer = buf })
vim.wait(100, function() return map_desc("[c") == "Blink previous change" end)
eq(map_desc("[c"), "Blink previous change", "Blink reclaims mappings after FileType plugin attachment")

local maps = vim.api.nvim_buf_get_keymap(buf, "n")
local descs = {}
for _, map in ipairs(maps) do descs[map.lhs] = map.desc end
local found = {}
for _, desc in pairs(descs) do found[desc] = true end
assert(found["Blink next change"] and found["Blink previous change"] and found["Blink first change"] and found["Blink last change"] and found["Blink next deletion"] and found["Blink previous deletion"] and found["Blink first deletion"] and found["Blink last deletion"] and found["Blink next changed file"] and found["Blink previous changed file"] and found["Blink first changed file"] and found["Blink latest changed file"] and found["Blink list changes"] and found["Blink toggle change panel"] and found["Blink comment"] and found["Blink help"], "required described mappings missing: " .. vim.inspect(descs))
eq(descs["]h"], "Blink toggle change panel", "]h owns the Blink panel mapping")
assert(descs["<Space>h"] == nil and descs[" h"] == nil, "legacy <leader>h Blink mapping remains: " .. vim.inspect(descs))
assert(found["Blink checkpoint and close"] and found["Blink close and retain history"], "Blitz close mappings missing: " .. vim.inspect(descs))
local help_message
local original_notify = vim.notify
vim.notify = function(message) help_message = message end
press("?")
vim.notify = original_notify
assert(help_message and help_message:match("%[c/%]c hunks") and help_message:match("%[C/%]C first/last hunk") and help_message:match("%[d/%]d deletions") and help_message:match("%[D/%]D first/last deletion") and help_message:match("%[n/%]n changed files") and help_message:match("%]h panel"), "Blink help omits current navigation: " .. tostring(help_message))

local panel_versions = {}
for version_id = 1, 12 do
  table.insert(panel_versions, { versionId = version_id, displayPath = "file" .. version_id .. ".txt", unread = version_id > 6 })
end
review:hide_change_list()
review.list_versions = {}
review:show_change_list()
eq(review.list_visible, false, "an empty change list does not arm the panel to open on a later update")
review:update_change_list(panel_versions, 8)
local file_navigation = {
  { "]n", { type = "navigate_global", payload = { delta = 1 } } },
  { "[n", { type = "navigate_global", payload = { delta = -1 } } },
  { "]N", { type = "navigate_edge", payload = { edge = "last" } } },
  { "[N", { type = "navigate_edge", payload = { edge = "first" } } },
}
for _, case in ipairs(file_navigation) do
  review:hide_change_list()
  press(case[1])
  eq(sent[#sent], case[2], case[1] .. " dispatches its file navigation action")
  eq(review.list_visible, true, case[1] .. " summons the change panel")
  assert(review.list_buf and vim.api.nvim_buf_is_valid(review.list_buf), case[1] .. " renders the change panel")
end

review:hide_change_list()
eq(review.list_visible, false, "change panel can be explicitly hidden")
review:update_change_list(panel_versions, 8)
eq(review.list_visible, false, "updating a hidden panel does not show it")
review:toggle_change_list()
eq(review.list_visible, true, "change panel can be shown")
eq(vim.api.nvim_buf_line_count(review.list_buf), 9, "change panel shows seven items plus more indicators")
eq(vim.api.nvim_buf_get_lines(review.list_buf, 0, 1, false)[1], "↑ 4 more", "panel reports more omitted changes above")
eq(vim.api.nvim_buf_get_lines(review.list_buf, -2, -1, false)[1], "↓ 1 more", "panel reports more omitted changes below")
review:toggle_change_list()
eq(review.list_visible, false, "change panel can be hidden")
review:update_change_list(panel_versions, 9)
eq(review.list_visible, false, "incoming changes do not reopen a hidden panel")
review:toggle_change_list()
eq(review.list_visible, true, "change panel can be reopened")
eq(vim.api.nvim_buf_line_count(review.list_buf), 8, "reopened panel restores seven items plus its more indicator")

for _, keys in ipairs({ "]c", "[c", "]C", "[C", "]d", "[d", "]D", "[D" }) do
  review:show_change_list()
  press(keys)
  eq(review.list_visible, false, keys .. " dismisses the change panel")
end

vim.bo[buf].readonly = false
vim.bo[buf].modifiable = true
vim.api.nvim_buf_set_lines(buf, 0, 1, false, { "tamper" })
vim.bo[buf].modifiable = false
local ok = pcall(vim.api.nvim_buf_call, buf, function() vim.cmd("write") end)
eq(ok, false, "write blocker")

review:evict(7)
assert(vim.api.nvim_buf_is_valid(buf), "evicting stale metadata does not close the reused current buffer")
review:evict(159)
eq(vim.api.nvim_buf_is_valid(buf), false, "evicting the displayed version closes the primary buffer")

local close_messages = {}
local close_exits = 0
local close_ui = ui.new({
  runtime_dir = tmp,
  send = function(message) table.insert(close_messages, message) end,
  exit = function() close_exits = close_exits + 1 end,
})
close_ui:request_close("checkpoint")
close_ui:request_close("retain")
eq(#close_messages, 1, "duplicate close requests are suppressed")
eq(close_messages[1].type, "client_checkpoint_close")
close_ui:complete_close({ action = "checkpoint", reset = true })
eq(close_exits, 1, "acknowledged close uses the injected exit callback")

local retain_messages = {}
local retain_ui = ui.new({
  runtime_dir = tmp,
  send = function(message) table.insert(retain_messages, message) end,
  exit = function() end,
})
retain_ui:request_close("retain")
eq(retain_messages[1].type, "client_retain_close")
retain_ui:complete_close({ action = "retain", reset = false })

local slow_ui = ui.new({ runtime_dir = tmp, send = function() end, exit = function() end })
local slow_buf = slow_ui:show_version({ transactionId = "slow", displayPath = "slow.txt", snapshotPath = eof_version, originKind = "file", originSnapshotPath = eof_origin })
local slow_descs = {}
for _, map in ipairs(vim.api.nvim_buf_get_keymap(slow_buf, "n")) do slow_descs[map.desc] = true end
assert(slow_descs["Blink dismiss and close"], "Slow close mapping missing")
assert(not slow_descs["Blink close and retain history"], "Slow mode must not offer retained history")
vim.api.nvim_buf_delete(slow_buf, { force = true })

vim.fn.delete(tmp, "rf")
print("blink nvim tests passed")
vim.cmd("qa!")
