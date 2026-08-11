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
  self.exit = options.exit or function() vim.cmd("qa!") end
  self.namespace = vim.api.nvim_create_namespace("blink-review")
  self.review_buf = nil
  self.review_state = nil
  self.buffers = {}
  self.buffer_state = {}
  self.sinks = {}
  self.list_buf = nil
  self.list_win = nil
  self.list_panel = nil
  self.list_visible = false
  self.list_versions = {}
  self.list_active_id = nil
  self.close_pending = false
  self.close_action = nil
  self.close_timer = nil
  return self
end

function UI:set_sinks(sinks)
  self.sinks = sinks or {}
end

function UI:_set_lines(buf, lines, has_eol)
  vim.bo[buf].readonly = false
  vim.bo[buf].modifiable = true
  local ok, err = pcall(vim.api.nvim_buf_set_lines, buf, 0, -1, false, lines)
  vim.bo[buf].endofline = has_eol
  vim.bo[buf].fixendofline = false
  vim.bo[buf].modifiable = false
  vim.bo[buf].readonly = true
  if not ok then error(err) end
end

function UI:_clear_close_timer()
  if not self.close_timer then return end
  if not self.close_timer:is_closing() then
    self.close_timer:stop()
    self.close_timer:close()
  end
  self.close_timer = nil
end

function UI:request_close(action)
  if self.close_pending then return end
  self.close_pending = true
  self.close_action = action
  local message_type = action == "checkpoint" and "client_checkpoint_close"
    or action == "retain" and "client_retain_close"
    or "client_closing"
  self.send({ type = message_type, payload = {} })
  self.close_timer = vim.uv.new_timer()
  self.close_timer:start(2500, 0, vim.schedule_wrap(function()
    self:_clear_close_timer()
    local message = self.close_action == "checkpoint"
      and "Blink close acknowledgement timed out; checkpoint status is unknown."
      or "Blink close acknowledgement timed out."
    vim.notify(message, vim.log.levels.ERROR)
    self.close_pending = false
    self.close_action = nil
    self.exit()
  end))
end

function UI:complete_close(payload)
  if not self.close_pending then return end
  self:_clear_close_timer()
  self.close_pending = false
  self.close_action = nil
  if payload and payload.error then vim.notify(payload.error, vim.log.levels.ERROR) end
  self.exit()
end

function UI:_set_review_name(buf, name)
  local ok, err = pcall(vim.api.nvim_buf_set_name, buf, name)
  if ok then return end
  local fallback = string.format("%s~%d", name, buf)
  local fallback_ok, fallback_err = pcall(vim.api.nvim_buf_set_name, buf, fallback)
  vim.schedule(function()
    vim.notify("Blink could not claim its preferred review buffer name: " .. tostring(err), vim.log.levels.ERROR)
  end)
  if not fallback_ok then error(fallback_err) end
end

function UI:_make_buffer(name, item, lines, has_eol)
  local buf = vim.api.nvim_create_buf(true, true)
  self.review_buf = buf
  vim.b[buf].blink_owned = true
  vim.b[buf].blink_role = "review"
  self:_set_review_name(buf, name)
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
  vim.api.nvim_create_autocmd("BufWipeout", {
    buffer = buf,
    callback = function()
      if self.review_buf == buf then
        self.review_buf = nil
        self.review_state = nil
      end
      self.buffer_state[buf] = nil
    end,
  })

  local map_options = { buffer = buf, silent = true }
  vim.keymap.set("n", "]c", function() self:navigate_hunk(1, vim.v.count1) end, vim.tbl_extend("force", map_options, { desc = "Blink next change" }))
  vim.keymap.set("n", "[c", function() self:navigate_hunk(-1, vim.v.count1) end, vim.tbl_extend("force", map_options, { desc = "Blink previous change" }))
  vim.keymap.set("n", "]n", function() self.send({ type = "navigate_global", payload = { delta = vim.v.count1 } }) end, vim.tbl_extend("force", map_options, { desc = "Blink next changed file" }))
  vim.keymap.set("n", "[n", function() self.send({ type = "navigate_global", payload = { delta = -vim.v.count1 } }) end, vim.tbl_extend("force", map_options, { desc = "Blink previous changed file" }))
  vim.keymap.set("n", "]N", function() self.send({ type = "navigate_edge", payload = { edge = "last" } }) end, vim.tbl_extend("force", map_options, { desc = "Blink latest changed file" }))
  vim.keymap.set("n", "[N", function() self.send({ type = "navigate_edge", payload = { edge = "first" } }) end, vim.tbl_extend("force", map_options, { desc = "Blink first changed file" }))
  local function current_item()
    return self.review_state and self.review_state.item or item
  end
  vim.keymap.set("n", "<leader>bc", function() self:comment(current_item(), nil) end, vim.tbl_extend("force", map_options, { desc = "Blink comment" }))
  vim.keymap.set("x", "<leader>bc", function()
    local first, last = vim.fn.line("'<"), vim.fn.line("'>")
    self:comment(current_item(), { startLine = math.min(first, last), endLine = math.max(first, last) })
  end, vim.tbl_extend("force", map_options, { desc = "Blink comment on selection" }))
  vim.keymap.set("n", "<leader>bt", function() self:todo(current_item()) end, vim.tbl_extend("force", map_options, { desc = "Blink submit TODO" }))
  if item.transactionId then
    vim.keymap.set("n", "<leader>bq", function() self:request_close("slow") end, vim.tbl_extend("force", map_options, { desc = "Blink dismiss and close" }))
    vim.keymap.set("n", "<leader>ba", function() self.send({ type = "slow_accept", payload = { transactionId = current_item().transactionId } }) end, vim.tbl_extend("force", map_options, { desc = "Blink accept" }))
    vim.keymap.set("n", "<leader>br", function() self.send({ type = "slow_reject", payload = { transactionId = current_item().transactionId } }) end, vim.tbl_extend("force", map_options, { desc = "Blink reject" }))
    vim.keymap.set("n", "<leader>bR", function()
      vim.ui.input({ prompt = "Blink rejection comment: " }, function(comment)
        if not comment or vim.trim(comment) == "" then return end
        self.send({ type = "slow_comment_reject", payload = { transactionId = current_item().transactionId, comment = comment } })
      end)
    end, vim.tbl_extend("force", map_options, { desc = "Blink reject with comment" }))
  else
    vim.keymap.set("n", "<leader>bq", function() self:request_close("checkpoint") end, vim.tbl_extend("force", map_options, { desc = "Blink checkpoint and close" }))
    vim.keymap.set("n", "<leader>bQ", function() self:request_close("retain") end, vim.tbl_extend("force", map_options, { desc = "Blink close and retain history" }))
    vim.keymap.set("n", "<leader>bp", function() self.send({ type = "toggle_pin", payload = {} }) end, vim.tbl_extend("force", map_options, { desc = "Blink toggle pin" }))
    vim.keymap.set("n", "<leader>bx", function()
      vim.ui.select({ "No", "Yes" }, { prompt = "Abort the running Pi agent?" }, function(choice)
        if choice == "Yes" then self.send({ type = "abort_agent", payload = {} }) end
      end)
    end, vim.tbl_extend("force", map_options, { desc = "Blink abort agent" }))
  end
  vim.keymap.set("n", "<leader>bl", function() self.send({ type = "list_changes", payload = {} }) end, vim.tbl_extend("force", map_options, { desc = "Blink list changes" }))
  vim.keymap.set("n", "<leader>bh", function() self:toggle_change_list() end, vim.tbl_extend("force", map_options, { desc = "Blink toggle change panel" }))
  vim.keymap.set("n", "?", function() self:help(current_item()) end, vim.tbl_extend("force", map_options, { desc = "Blink help" }))

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

local function blink_review_buffer(buf)
  if not vim.api.nvim_buf_is_valid(buf) then return false end
  if vim.b[buf].blink_owned and vim.b[buf].blink_role == "review" then return true end
  return vim.api.nvim_buf_get_name(buf):match("^blink://") ~= nil
    and vim.api.nvim_buf_get_name(buf) ~= "blink://changes"
    and vim.api.nvim_buf_get_name(buf) ~= "blink://waiting"
end

function UI:_set_buffer_identity(buf, item)
  vim.b[buf].blink_owned = true
  vim.b[buf].blink_role = "review"
  vim.b[buf].blink_file_id = item.fileId
  vim.b[buf].blink_absolute_path = item.absolutePath
  vim.b[buf].blink_canonical_path = item.canonicalPath
  vim.b[buf].blink_filesystem_key = item.filesystemKey
  vim.b[buf].blink_version_id = item.versionId
end

function UI:_sweep_review_buffers(keep_buf)
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if buf ~= keep_buf and blink_review_buffer(buf) then
      local ok, err = pcall(vim.api.nvim_buf_delete, buf, { force = true })
      if ok then
        self.buffer_state[buf] = nil
        for version_id, tracked in pairs(vim.deepcopy(self.buffers)) do
          if tracked == buf then self.buffers[version_id] = nil end
        end
      else
        vim.schedule(function() vim.notify("Blink could not remove stale review buffer: " .. tostring(err), vim.log.levels.ERROR) end)
      end
    end
  end
end

function UI:_close_other_buffers_for_file(active_buf, _item)
  self:_sweep_review_buffers(active_buf)
end

local function change_label(item)
  local prefix = item.unread and "● " or "  "
  return string.format("%s%s@%s", prefix, item.displayPath or "file", tostring(item.versionId))
end

function UI:_close_change_list()
  if self.list_panel and self.list_panel.close then pcall(function() self.list_panel:close() end) end
  if self.list_win and vim.api.nvim_win_is_valid(self.list_win) then pcall(vim.api.nvim_win_close, self.list_win, true) end
  self.list_panel = nil
  self.list_win = nil
end

function UI:toggle_change_list()
  self.list_visible = not self.list_visible
  if self.list_visible then
    self:update_change_list(self.list_versions, self.list_active_id)
  else
    self:_close_change_list()
  end
end

function UI:_snacks()
  if type(Snacks) == "table" and Snacks.win then return Snacks end
  local ok, snacks = pcall(require, "snacks")
  if ok and type(snacks) == "table" and snacks.win then return snacks end
  return nil
end

function UI:_change_list_opts(width, height)
  return {
    relative = "editor",
    anchor = "NE",
    row = 1,
    col = vim.o.columns,
    width = width,
    height = height,
    focusable = false,
    border = "rounded",
    title = " Blink changes ",
    title_pos = "center",
    zindex = 40,
    noautocmd = true,
  }
end

function UI:update_change_list(versions, active_id)
  versions = versions or {}
  self.list_versions = versions
  self.list_active_id = active_id
  if #versions == 0 or not self.list_visible then
    self:_close_change_list()
    return
  end
  if not self.list_buf or not vim.api.nvim_buf_is_valid(self.list_buf) then
    self.list_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_name(self.list_buf, "blink://changes")
    vim.bo[self.list_buf].buftype = "nofile"
    vim.bo[self.list_buf].bufhidden = "hide"
    vim.bo[self.list_buf].swapfile = false
    vim.bo[self.list_buf].buflisted = false
  end
  local active_index = #versions
  for index, item in ipairs(versions) do
    if item.versionId == active_id then active_index = index; break end
  end
  local first = math.max(1, math.min(active_index - 3, #versions - 6))
  local last = math.min(#versions, first + 6)
  local lines = {}
  local width = 16
  local active_line
  local top_offset = 0
  if first > 1 then
    table.insert(lines, string.format("↑ %d older", first - 1))
    top_offset = 1
  end
  for index = first, last do
    local item = versions[index]
    local line = change_label(item)
    if item.versionId == active_id then line = "▶ " .. line:sub(3); active_line = #lines + 1 end
    width = math.max(width, vim.fn.strdisplaywidth(line))
    table.insert(lines, line)
  end
  if last < #versions then table.insert(lines, string.format("↓ %d newer", #versions - last)) end
  for _, line in ipairs(lines) do width = math.max(width, vim.fn.strdisplaywidth(line)) end
  width = math.min(math.max(width, 16), math.max(16, vim.o.columns - 4))
  vim.bo[self.list_buf].modifiable = true
  vim.api.nvim_buf_set_lines(self.list_buf, 0, -1, false, lines)
  vim.bo[self.list_buf].modifiable = false
  vim.bo[self.list_buf].readonly = true
  vim.api.nvim_buf_clear_namespace(self.list_buf, self.namespace, 0, -1)
  for index = first, last do
    local item = versions[index]
    local row = index - first + top_offset
    local line = lines[row + 1]
    if item.versionId == active_id then
      vim.api.nvim_buf_set_extmark(self.list_buf, self.namespace, row, 0, {
        end_col = #line,
        hl_group = "SnacksNotifierTitleInfo",
      })
    elseif item.unread then
      vim.api.nvim_buf_set_extmark(self.list_buf, self.namespace, row, 0, {
        end_col = math.min(3, #line),
        hl_group = "SnacksNotifierIconInfo",
      })
    end
  end
  local opts = self:_change_list_opts(width, math.min(#lines, math.max(1, vim.o.lines - 4)))
  local snacks = self:_snacks()
  if snacks then
    if self.list_win and vim.api.nvim_win_is_valid(self.list_win) then pcall(vim.api.nvim_win_close, self.list_win, true); self.list_win = nil end
    local win_opts = vim.tbl_extend("force", opts, {
      buf = self.list_buf,
      enter = false,
      backdrop = false,
      minimal = true,
      fixbuf = true,
      resize = true,
      show = true,
      keys = {},
      wo = {
        winhighlight = "Normal:Normal,NormalNC:Normal,NormalFloat:Normal,FloatBorder:Normal,FloatTitle:Normal",
        winblend = 0,
      },
      bo = {
        buftype = "nofile",
        bufhidden = "hide",
        buflisted = false,
        swapfile = false,
      },
    })
    if self.list_panel and self.list_panel.valid and self.list_panel:valid() then
      self.list_panel.opts = vim.tbl_deep_extend("force", self.list_panel.opts or {}, win_opts)
      self.list_panel:update()
    else
      self.list_panel = snacks.win(win_opts)
    end
    if active_line and self.list_panel and self.list_panel.win then pcall(vim.api.nvim_win_set_cursor, self.list_panel.win, { active_line, 0 }) end
  else
    if self.list_panel and self.list_panel.close then pcall(function() self.list_panel:close() end); self.list_panel = nil end
    local raw_opts = vim.tbl_extend("force", opts, { style = "minimal" })
    if self.list_win and vim.api.nvim_win_is_valid(self.list_win) then
      vim.api.nvim_win_set_config(self.list_win, raw_opts)
    else
      self.list_win = vim.api.nvim_open_win(self.list_buf, false, raw_opts)
    end
    pcall(vim.api.nvim_win_set_option, self.list_win, "winhl", "Normal:Normal,NormalNC:Normal,NormalFloat:Normal,FloatBorder:Normal,FloatTitle:Normal")
    if active_line then pcall(vim.api.nvim_win_set_cursor, self.list_win, { active_line, 0 }) end
  end
  pcall(vim.cmd, "redraw")
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
  local buf = self.review_buf
  if buf and not vim.api.nvim_buf_is_valid(buf) then
    self.review_buf = nil
    self.review_state = nil
    buf = nil
  end
  self:_sweep_review_buffers(buf)
  if not buf then
    buf = self:_make_buffer(name, item, lines, has_eol)
  else
    local old_name = vim.api.nvim_buf_get_name(buf)
    if old_name ~= name then self:_set_review_name(buf, name) end
    vim.bo[buf].filetype = vim.filetype.match({ filename = item.displayPath }) or ""
    self:_set_lines(buf, lines, has_eol)
  end
  self.buffers = { [key] = buf }
  self:_set_buffer_identity(buf, item)
  local hunks = self:_calculate(item.originKind, origin_text, version_text)
  local requested = tonumber(item.firstChangedLine) or 0
  local first_hunk = hunks[1]
  local location = requested > 0 and requested or (first_hunk and first_hunk[3] or 1)
  local active_hunk = #hunks > 0 and 1 or nil
  local nearest_distance
  for index, hunk in ipairs(hunks) do
    local anchor = math.max(1, hunk[3])
    local distance = math.abs(anchor - location)
    if not nearest_distance or distance < nearest_distance then active_hunk, nearest_distance = index, distance end
  end
  self.buffer_state = { [buf] = {
    item = item,
    origin_lines = split_lines(origin_text),
    hunks = hunks,
    active_hunk = active_hunk,
    has_eol = has_eol,
  } }
  self.review_state = self.buffer_state[buf]
  self:render(buf)
  vim.api.nvim_set_current_buf(buf)
  self:_close_other_buffers_for_file(buf, item)
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
  local line_count = vim.api.nvim_buf_line_count(buf)
  local counter_hl = vim.fn.hlexists("NoiceVirtualText") == 1 and "NoiceVirtualText" or "DiagnosticVirtualTextInfo"
  for hunk_index, hunk in ipairs(data.hunks) do
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
      local reaches_origin_end = origin_start + origin_count - 1 >= #data.origin_lines
      local after_eof = version_count == 0 and reaches_origin_end and origin_start > line_count
      local anchor = after_eof and (line_count - 1) or math.max(0, math.min(version_start - 1, line_count - 1))
      vim.api.nvim_buf_set_extmark(buf, self.namespace, anchor, 0, {
        virt_lines = virtual,
        virt_lines_above = not after_eof,
      })
    end
    local counter_row = math.max(0, math.min(math.max(1, version_start) - 1, line_count - 1))
    vim.api.nvim_buf_set_extmark(buf, self.namespace, counter_row, 0, {
      virt_text = { { string.format("[%d/%d]", hunk_index, #data.hunks), hunk_index == data.active_hunk and counter_hl or "Comment" } },
      virt_text_pos = "right_align",
      priority = 120,
    })
  end
  if not data.has_eol then
    local row = math.max(0, vim.api.nvim_buf_line_count(buf) - 1)
    vim.api.nvim_buf_set_extmark(buf, self.namespace, row, 0, {
      virt_text = { { "  [no final newline]", "Comment" } },
      virt_text_pos = "eol",
    })
  end
end

function UI:navigate_hunk(delta, count)
  local buf = self.review_buf
  local data = buf and self.buffer_state[buf] or nil
  local hunks = data and data.hunks or {}
  if #hunks == 0 then vim.notify("No Blink changes."); return end

  local line_count = vim.api.nvim_buf_line_count(buf)
  local function anchor(index)
    return math.max(1, math.min(math.max(1, hunks[index][3]), line_count))
  end

  local current = vim.api.nvim_win_get_cursor(0)[1]
  local direction = delta > 0 and 1 or -1
  local target_index
  if direction > 0 then
    for index = 1, #hunks do if anchor(index) > current then target_index = index; break end end
    target_index = target_index or 1
  else
    for index = #hunks, 1, -1 do if anchor(index) < current then target_index = index; break end end
    target_index = target_index or #hunks
  end

  target_index = ((target_index - 1 + direction * (math.max(1, count or 1) - 1)) % #hunks) + 1
  data.active_hunk = target_index
  self:render(buf)
  vim.api.nvim_win_set_cursor(0, { anchor(target_index), 0 })
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
  local close_help = item.transactionId
    and "<leader>bq dismiss/close"
    or "<leader>bq checkpoint/close, <leader>bQ close/retain"
  local mode = item.transactionId and "Slow" or "Blitz"
  vim.notify("Blink " .. mode .. ": [c/]c hunks, [n/]n changed files (count supported), [N/]N first/latest changed file, <leader>bl list, <leader>bh panel, " .. close_help)
end

function UI:evict(version_id)
  local buf = self.review_buf
  local item = self.review_state and self.review_state.item
  if not buf or not item or item.versionId ~= version_id then return end
  local ok, err = pcall(vim.api.nvim_buf_delete, buf, { force = true })
  if not ok then
    vim.notify("Blink could not remove evicted review buffer: " .. tostring(err), vim.log.levels.ERROR)
    return
  end
  self.review_buf = nil
  self.review_state = nil
  self.buffers = {}
  self.buffer_state = {}
end

return UI
