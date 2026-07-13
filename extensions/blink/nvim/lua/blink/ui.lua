local UI = {}
UI.__index = UI

local function starts_with_path(path, root)
  local normalized_root = vim.fs.normalize(root)
  local normalized = vim.fs.normalize(path)
  return normalized == normalized_root or normalized:sub(1, #normalized_root + 1) == normalized_root .. "/"
end

local function read_bytes(path, runtime_dir)
  if not starts_with_path(path, runtime_dir) then error("Blink rejected a snapshot path outside its runtime directory") end
  local fd, open_error = vim.uv.fs_open(path, "r", 0)
  if not fd then error(open_error) end
  local stat = assert(vim.uv.fs_fstat(fd))
  local bytes, read_error = vim.uv.fs_read(fd, stat.size, 0)
  vim.uv.fs_close(fd)
  if not bytes then error(read_error) end
  return bytes
end

local function normalize_visual(bytes)
  return bytes:gsub("\r\n", "\n"):gsub("\r", "\n")
end

local function split_lines(text)
  if text == "" then return { "" }, false end
  local has_eol = text:sub(-1) == "\n"
  if has_eol then text = text:sub(1, -2) end
  local lines = vim.split(text, "\n", { plain = true })
  if #lines == 0 then lines = { "" } end
  return lines, has_eol
end

local function hunk_key(hunk)
  return string.format("%d:%d:%d:%d", hunk[1], hunk[2], hunk[3], hunk[4])
end

function UI.new(options)
  local self = setmetatable({}, UI)
  self.runtime_dir = assert(options.runtime_dir)
  self.send = assert(options.send)
  self.namespace = vim.api.nvim_create_namespace("blink-review")
  self.buffers = {}
  self.buffer_state = {}
  self.sinks = {}
  return self
end

function UI:set_sinks(sinks)
  self.sinks = sinks or {}
end

function UI:_set_lines(buf, lines, has_eol)
  vim.bo[buf].modifiable = true
  local ok, err = pcall(vim.api.nvim_buf_set_lines, buf, 0, -1, false, lines)
  vim.bo[buf].endofline = has_eol
  vim.bo[buf].fixendofline = false
  vim.bo[buf].modifiable = false
  if not ok then error(err) end
end

function UI:_make_buffer(name, item, lines, has_eol)
  local buf = vim.api.nvim_create_buf(true, true)
  vim.api.nvim_buf_set_name(buf, name)
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].bufhidden = "hide"
  vim.bo[buf].swapfile = false
  vim.bo[buf].buflisted = true
  vim.bo[buf].readonly = true
  vim.bo[buf].modifiable = false
  vim.bo[buf].filetype = vim.filetype.match({ filename = item.displayPath }) or ""
  self:_set_lines(buf, lines, has_eol)
  vim.bo[buf].readonly = true

  vim.api.nvim_create_autocmd("BufWriteCmd", {
    buffer = buf,
    callback = function() error("Blink review buffers are read-only") end,
  })

  local map_options = { buffer = buf, silent = true }
  vim.keymap.set("n", "]c", function() self:navigate_hunk(buf, 1) end, vim.tbl_extend("force", map_options, { desc = "Blink next change" }))
  vim.keymap.set("n", "[c", function() self:navigate_hunk(buf, -1) end, vim.tbl_extend("force", map_options, { desc = "Blink previous change" }))
  vim.keymap.set("n", "]f", function() self.send({ type = "navigate_version", payload = { delta = 1 } }) end, vim.tbl_extend("force", map_options, { desc = "Blink next version" }))
  vim.keymap.set("n", "[f", function() self.send({ type = "navigate_version", payload = { delta = -1 } }) end, vim.tbl_extend("force", map_options, { desc = "Blink previous version" }))
  vim.keymap.set("n", "<leader>bc", function() self:comment(item, nil) end, vim.tbl_extend("force", map_options, { desc = "Blink comment" }))
  vim.keymap.set("x", "<leader>bc", function()
    local first, last = vim.fn.line("'<"), vim.fn.line("'>")
    self:comment(item, { startLine = math.min(first, last), endLine = math.max(first, last) })
  end, vim.tbl_extend("force", map_options, { desc = "Blink comment on selection" }))
  vim.keymap.set("n", "<leader>bt", function() self:todo(item) end, vim.tbl_extend("force", map_options, { desc = "Blink submit TODO" }))
  if item.transactionId then
    vim.keymap.set("n", "<leader>ba", function() self.send({ type = "slow_accept", payload = { transactionId = item.transactionId } }) end, vim.tbl_extend("force", map_options, { desc = "Blink accept" }))
    vim.keymap.set("n", "<leader>br", function() self.send({ type = "slow_reject", payload = { transactionId = item.transactionId } }) end, vim.tbl_extend("force", map_options, { desc = "Blink reject" }))
    vim.keymap.set("n", "<leader>bR", function()
      vim.ui.input({ prompt = "Blink rejection comment: " }, function(comment)
        if not comment or vim.trim(comment) == "" then return end
        self.send({ type = "slow_comment_reject", payload = { transactionId = item.transactionId, comment = comment } })
      end)
    end, vim.tbl_extend("force", map_options, { desc = "Blink reject with comment" }))
  else
    vim.keymap.set("n", "<leader>bp", function() self.send({ type = "toggle_pin", payload = {} }) end, vim.tbl_extend("force", map_options, { desc = "Blink toggle pin" }))
    vim.keymap.set("n", "<leader>bx", function()
      vim.ui.select({ "No", "Yes" }, { prompt = "Abort the running Pi agent?" }, function(choice)
        if choice == "Yes" then self.send({ type = "abort_agent", payload = {} }) end
      end)
    end, vim.tbl_extend("force", map_options, { desc = "Blink abort agent" }))
  end
  vim.keymap.set("n", "<leader>bq", function() self.send({ type = "client_closing", payload = {} }); vim.cmd("qa!") end, vim.tbl_extend("force", map_options, { desc = "Blink dismiss review (keep change)" }))
  vim.keymap.set("n", "?", function() self:help(item) end, vim.tbl_extend("force", map_options, { desc = "Blink help" }))

  pcall(function() require("gitsigns").detach(buf) end)
  return buf
end

function UI:_calculate(origin_kind, origin_text, version_text)
  if origin_kind == "absent" then
    local lines = split_lines(version_text)
    local count = #lines
    if version_text == "" then count = 0 end
    if count == 0 then return {} end
    return { { 1, 0, 1, count } }
  end
  return vim.diff(origin_text, version_text, { result_type = "indices", algorithm = "histogram" })
end

function UI:show_version(item)
  local version_text = normalize_visual(read_bytes(item.snapshotPath, self.runtime_dir))
  local origin_text = ""
  if item.originKind ~= "absent" then
    origin_text = normalize_visual(read_bytes(assert(item.originSnapshotPath), self.runtime_dir))
  end
  local lines, has_eol = split_lines(version_text)
  local key = item.versionId or item.transactionId
  local name
  if item.transactionId then
    name = string.format("blink://%s@slow-%s", item.displayPath, item.transactionId)
  else
    name = string.format("blink://%s@%s", item.displayPath, item.versionId)
  end
  local buf = self.buffers[key]
  if not buf or not vim.api.nvim_buf_is_valid(buf) then
    buf = self:_make_buffer(name, item, lines, has_eol)
    self.buffers[key] = buf
  else
    self:_set_lines(buf, lines, has_eol)
  end
  self.buffer_state[buf] = {
    item = item,
    origin_lines = split_lines(origin_text),
    hunks = self:_calculate(item.originKind, origin_text, version_text),
    has_eol = has_eol,
  }
  self:render(buf)
  vim.api.nvim_set_current_buf(buf)
  local requested = tonumber(item.firstChangedLine) or 0
  local first_hunk = self.buffer_state[buf].hunks[1]
  local location = requested > 0 and requested or (first_hunk and first_hunk[3] or 1)
  local target = math.max(1, math.min(location, vim.api.nvim_buf_line_count(buf)))
  pcall(vim.api.nvim_win_set_cursor, 0, { target, 0 })
  return buf
end

function UI:show_waiting()
  if self.waiting_buf and vim.api.nvim_buf_is_valid(self.waiting_buf) then
    vim.api.nvim_set_current_buf(self.waiting_buf)
    return self.waiting_buf
  end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buf, "blink://waiting")
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].swapfile = false
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "Blink is waiting for a review version…" })
  vim.bo[buf].modifiable = false
  vim.bo[buf].readonly = true
  self.waiting_buf = buf
  vim.api.nvim_set_current_buf(buf)
  return buf
end

function UI:get_hunks(buf)
  return (self.buffer_state[buf] and self.buffer_state[buf].hunks) or {}
end

function UI:render(buf)
  local data = assert(self.buffer_state[buf])
  vim.api.nvim_buf_clear_namespace(buf, self.namespace, 0, -1)
  for _, hunk in ipairs(data.hunks) do
    local origin_start, origin_count, version_start, version_count = hunk[1], hunk[2], hunk[3], hunk[4]
    for line = version_start, version_start + version_count - 1 do
      local row = math.max(0, math.min(line - 1, vim.api.nvim_buf_line_count(buf) - 1))
      vim.api.nvim_buf_set_extmark(buf, self.namespace, row, 0, {
        line_hl_group = "DiffAdd",
        sign_text = "+",
        sign_hl_group = "DiffAdd",
      })
    end
    if origin_count > 0 then
      local virtual = {}
      for line = origin_start, origin_start + origin_count - 1 do
        table.insert(virtual, { { "-" .. (data.origin_lines[line] or ""), "DiffDelete" } })
      end
      local line_count = vim.api.nvim_buf_line_count(buf)
      local reaches_origin_end = origin_start + origin_count - 1 >= #data.origin_lines
      local after_eof = version_count == 0 and reaches_origin_end and origin_start > line_count
      local anchor = after_eof and (line_count - 1) or math.max(0, math.min(version_start - 1, line_count - 1))
      vim.api.nvim_buf_set_extmark(buf, self.namespace, anchor, 0, {
        virt_lines = virtual,
        virt_lines_above = not after_eof,
      })
    end
  end
  if not data.has_eol then
    local row = math.max(0, vim.api.nvim_buf_line_count(buf) - 1)
    vim.api.nvim_buf_set_extmark(buf, self.namespace, row, 0, {
      virt_text = { { "  [no final newline]", "Comment" } },
      virt_text_pos = "eol",
    })
  end
end

function UI:navigate_hunk(buf, delta)
  local hunks = self:get_hunks(buf)
  if #hunks == 0 then vim.notify("No Blink changes."); return end
  local current = vim.api.nvim_win_get_cursor(0)[1]
  local target
  if delta > 0 then
    for _, h in ipairs(hunks) do if h[3] > current then target = h[3]; break end end
    target = target or hunks[1][3]
  else
    for i = #hunks, 1, -1 do if hunks[i][3] < current then target = hunks[i][3]; break end end
    target = target or hunks[#hunks][3]
  end
  vim.api.nvim_win_set_cursor(0, { math.max(1, target), 0 })
end

function UI:comment(item, range)
  vim.ui.input({ prompt = "Blink comment: " }, function(comment)
    if not comment or vim.trim(comment) == "" then return end
    self.send({ type = item.transactionId and "slow_comment_keep" or "submit_agent_feedback", payload = {
      transactionId = item.transactionId,
      versionId = item.versionId,
      fileId = item.fileId,
      range = range,
      comment = comment,
    } })
  end)
end

function UI:todo(item)
  vim.ui.input({ prompt = "Blink TODO: " }, function(comment)
    if not comment or vim.trim(comment) == "" then return end
    local function submit(sink)
      self.send({ type = "submit_todo", payload = {
        transactionId = item.transactionId,
        versionId = item.versionId,
        fileId = item.fileId,
        sinkId = sink and sink.id or nil,
        comment = comment,
      } })
    end
    if #self.sinks <= 1 then submit(self.sinks[1]); return end
    vim.ui.select(self.sinks, { prompt = "Blink TODO sink:", format_item = function(sink) return sink.label end }, function(sink)
      if sink then submit(sink) end
    end)
  end)
end

function UI:help(item)
  local mode = item.transactionId and "Slow" or "Blitz"
  vim.notify("Blink " .. mode .. ": [c/]c changes, [f/]f versions, <leader>bc comment, <leader>bt TODO, <leader>bq close")
end

function UI:evict(version_id)
  local buf = self.buffers[version_id]
  self.buffers[version_id] = nil
  if buf and vim.api.nvim_buf_is_valid(buf) then
    self.buffer_state[buf] = nil
    vim.api.nvim_buf_delete(buf, { force = true })
  end
end

return UI
