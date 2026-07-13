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
eq(vim.tbl_map(function(v) return v.versionId end, model.versions), { 2 }, "snapshot keeps only latest version per file")
state.set_active(model, 2)
state.toggle_pin(model)
local added, removed = state.add(model, { versionId = 3, fileId = "f", displayPath = "a.txt", snapshotPath = "/tmp/3", originKind = "file", originSnapshotPath = "/tmp/o" }, true)
eq(added.versionId, 3, "same-file update keeps latest")
eq(removed, { 2 }, "same-file update removes older visible version")
eq(model.activeVersionId, 3, "same-file latest replaces pinned older buffer")
eq(model.by_id[2], nil, "older same-file version hidden from model")
state.add(model, { versionId = 4, fileId = "g", displayPath = "b.txt", snapshotPath = "/tmp/4", originKind = "absent" }, true)
eq(vim.tbl_map(function(v) return v.versionId end, model.versions), { 3, 4 })
eq(state.navigate_file(model, 3, -1).versionId, 4, "file navigation wraps")

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
assert(found["Blink next change"] and found["Blink previous change"] and found["Blink comment"], "required described mappings missing: " .. vim.inspect(descs))

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
