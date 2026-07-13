local root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p:h:h:h")
package.path = root .. "/nvim/lua/?.lua;" .. root .. "/nvim/lua/?/init.lua;" .. package.path

local state = require("blink.state")
local ui = require("blink.ui")

local function eq(actual, expected, message)
  if not vim.deep_equal(actual, expected) then
    error((message or "not equal") .. "\nactual: " .. vim.inspect(actual) .. "\nexpected: " .. vim.inspect(expected))
  end
end

local model = state.new("review", "blitz")
state.replace(model, {
  mode = "blitz",
  versions = {
    { versionId = 2, fileId = "f", displayPath = "a.txt", snapshotPath = "/tmp/2", originKind = "file", originSnapshotPath = "/tmp/o" },
    { versionId = 1, fileId = "f", displayPath = "a.txt", snapshotPath = "/tmp/1", originKind = "file", originSnapshotPath = "/tmp/o" },
  },
})
eq(vim.tbl_map(function(v) return v.versionId end, model.versions), { 1, 2 }, "snapshot sorts versions")
state.set_active(model, 1)
state.toggle_pin(model)
local added = state.add(model, { versionId = 3, fileId = "f", displayPath = "a.txt", snapshotPath = "/tmp/3", originKind = "file", originSnapshotPath = "/tmp/2" }, true)
eq(added.versionId, 3, "same-file rolling diff is retained")
eq(model.activeVersionId, 1, "newer diff does not auto-replace the current view")
eq(model.by_id[3].unread, true, "newer diff is marked unread")
state.evict(model, 1)
eq(model.activeVersionId, 2, "eviction selects nearest")
eq(vim.tbl_map(function(v) return v.versionId end, model.versions), { 2, 3 })
eq(state.navigate_file(model, 2, -1).versionId, 3, "same-file navigation wraps")
state.add(model, { versionId = 4, fileId = "g", displayPath = "b.txt", snapshotPath = "/tmp/4", originKind = "absent" }, true)
eq(state.navigate_file(model, 3, 1).versionId, 2, "file navigation stays within current file")
eq(state.navigate_global(model, 3, 1).versionId, 4, "global navigation crosses files")

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
review:navigate_hunk(buf, 1)
eq(vim.api.nvim_win_get_cursor(0)[1], hunks[2][3], "]c moves to the next counted hunk")
eq(review.buffer_state[buf].active_hunk, 2, "hunk counter tracks navigation")

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
  displayPath = "new.txt",
  snapshotPath = absent,
  originKind = "absent",
  firstChangedLine = 1,
})
eq(#review:get_hunks(newbuf), 1)
local h = review:get_hunks(newbuf)[1]
eq({ h[1], h[2], h[3], h[4] }, { 1, 0, 1, 2 }, "absent origin is additions-only")

local eof_origin = tmp .. "/eof-origin"
local eof_version = tmp .. "/eof-version"
vim.fn.writefile({ "keep", "delete" }, eof_origin)
vim.fn.writefile({ "keep" }, eof_version)
local eof_buf = review:show_version({ versionId = 9, fileId = "eof", displayPath = "eof.txt", snapshotPath = eof_version, originKind = "file", originSnapshotPath = eof_origin })
local eof_marks = vim.api.nvim_buf_get_extmarks(eof_buf, review.namespace, 0, -1, { details = true })
local found_eof_deletion = false
for _, mark in ipairs(eof_marks) do
  if mark[4].virt_lines and mark[4].virt_lines_above == false then found_eof_deletion = true end
end
assert(found_eof_deletion, "EOF deletion must render after the final surviving line: hunks=" .. vim.inspect(review:get_hunks(eof_buf)) .. " marks=" .. vim.inspect(eof_marks))

local maps = vim.api.nvim_buf_get_keymap(buf, "n")
local descs = {}
for _, map in ipairs(maps) do descs[map.lhs] = map.desc end
local found = {}
for _, desc in pairs(descs) do found[desc] = true end
assert(found["Blink next change"] and found["Blink previous change"] and found["Blink next version for file"] and found["Blink next version globally"] and found["Blink list changes"] and found["Blink comment"], "required described mappings missing: " .. vim.inspect(descs))

vim.bo[buf].modifiable = true
vim.api.nvim_buf_set_lines(buf, 0, 1, false, { "tamper" })
vim.bo[buf].modifiable = false
local ok = pcall(vim.api.nvim_buf_call, buf, function() vim.cmd("write") end)
eq(ok, false, "write blocker")

review:evict(7)
eq(vim.api.nvim_buf_is_valid(buf), false, "eviction closes only matching buffer")
assert(vim.api.nvim_buf_is_valid(newbuf), "other version remains")

vim.fn.delete(tmp, "rf")
print("blink nvim tests passed")
