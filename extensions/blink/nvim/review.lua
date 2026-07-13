local function required(name)
  local value = vim.env[name]
  if not value or value == "" then error("Blink requires " .. name) end
  return value
end

local review_id = required("BLINK_REVIEW_ID")
local socket_path = required("BLINK_SOCKET_PATH")
local mode = required("BLINK_MODE")
local cwd = required("BLINK_CWD")
if required("BLINK_PROTOCOL_VERSION") ~= "1" then error("Unsupported Blink protocol") end
if mode ~= "slow" and mode ~= "blitz" then error("Invalid Blink mode") end

local script = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p:h")
package.path = script .. "/lua/?.lua;" .. script .. "/lua/?/init.lua;" .. package.path

local State = require("blink.state")
local UI = require("blink.ui")
local Client = require("blink.protocol")
local model = State.new(review_id, mode)
local client
local ui

local function pane_active()
  local pane = vim.env.TMUX_PANE
  if not pane or pane == "" then return true end
  local result = vim.system({ "tmux", "display-message", "-p", "-t", pane, "#{pane_active}" }, { text = true }):wait()
  return result.code == 0 and vim.trim(result.stdout or "") == "1"
end

local function refresh_change_list()
  if ui then ui:update_change_list(model.versions, model.activeVersionId) end
end

local function show_active()
  local item = model.activeVersionId and model.by_id[model.activeVersionId] or nil
  if item then ui:show_version(item) else ui:show_waiting() end
  refresh_change_list()
end

local function change_label(item)
  local marker = item.unread and "● " or "  "
  return string.format("%s%s@%s", marker, item.displayPath or "file", tostring(item.versionId))
end

local function notify(message, level)
  local snacks = type(Snacks) == "table" and Snacks or nil
  if not snacks then
    local ok, loaded = pcall(require, "snacks")
    if ok then snacks = loaded end
  end
  if snacks and snacks.notify then
    local ok = pcall(snacks.notify, message, {
      level = level or vim.log.levels.INFO,
      title = "Blink",
      style = "compact",
    })
    if ok then return end
  end
  local ok = pcall(vim.notify, message, level or vim.log.levels.INFO, { title = "Blink" })
  if not ok then pcall(vim.api.nvim_echo, { { message, "MoreMsg" } }, false, {}) end
end

local function send(action)
  if action.type == "navigate_file" or action.type == "navigate_global" then
    local navigate = action.type == "navigate_file" and State.navigate_file or State.navigate_global
    local selected = navigate(model, model.activeVersionId, action.payload.delta)
    if selected then ui:show_version(selected); refresh_change_list() end
    return
  end
  if action.type == "list_changes" then
    if #model.versions == 0 then notify("No Blink changes."); return end
    vim.ui.select(model.versions, {
      prompt = "Blink changes:",
      kind = "blink_changes",
      format_item = change_label,
      snacks = {
        layout = {
          preset = "select",
          layout = {
            border = "rounded",
            title = " Blink changes ",
            title_pos = "center",
          },
        },
      },
    }, function(selected)
      if selected and State.set_active(model, selected.versionId) then ui:show_version(selected); refresh_change_list() end
    end)
    return
  end
  if action.type == "toggle_pin" then
    local pinned = State.toggle_pin(model)
    notify("Blink " .. (pinned and "pinned" or "auto-following"))
    return
  end
  client:send(action.type, action.payload)
end

ui = UI.new({ runtime_dir = vim.fs.dirname(socket_path), send = send })

local function on_message(message)
  local payload = message.payload or {}
  if message.type == "hello" then
    ui:set_sinks(payload.sinks)
    client:send("request_state", {})
  elseif message.type == "state_snapshot" then
    if payload.mode == "slow" and payload.transaction then
      ui:show_version(payload.transaction)
    else
      State.replace(model, payload)
      show_active()
    end
  elseif message.type == "version_added" then
    local item = State.add(model, payload.version, pane_active())
    if model.activeVersionId == item.versionId then
      ui:show_version(item)
      refresh_change_list()
    else
      refresh_change_list()
      notify(string.format('Edited "%s"', vim.fs.basename(item.displayPath or "file")))
    end
  elseif message.type == "version_evicted" then
    local replacement = State.evict(model, payload.versionId)
    if replacement then ui:show_version(replacement) else ui:show_waiting() end
    ui:evict(payload.versionId)
    refresh_change_list()
  elseif message.type == "shutdown" then
    client:close()
    vim.cmd("qa!")
  elseif message.type == "slow_action_result" then
    if payload.settled then vim.cmd("qa!") elseif payload.error then notify(payload.error, vim.log.levels.ERROR) end
  elseif message.type == "sink_list_changed" then
    ui:set_sinks(payload.sinks)
  elseif message.type == "feedback_result" then
    notify(payload.error or "Feedback submitted", payload.error and vim.log.levels.ERROR or vim.log.levels.INFO)
  elseif message.type == "agent_abort_requested" or message.type == "agent_abort_unavailable" or message.type == "error" then
    notify(payload.message or message.type, message.type == "error" and vim.log.levels.ERROR or vim.log.levels.INFO)
  end
end

client = Client.new({
  socket_path = socket_path,
  review_id = review_id,
  on_message = on_message,
  on_disconnect = function()
    if vim.v.exiting == vim.NIL or vim.v.exiting == 0 then vim.schedule(function() pcall(vim.cmd, "qa!") end) end
  end,
})

vim.api.nvim_set_current_dir(cwd)
client:connect(function(connect_error)
  if connect_error then error("Blink connection failed: " .. tostring(connect_error)) end
  client:send("client_ready", { nvimVersion = tostring(vim.version()), mode = mode })
end)
