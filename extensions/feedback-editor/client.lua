local socket_path = assert(vim.env.PI_FEEDBACK_SOCKET, "PI_FEEDBACK_SOCKET is missing")
local pipe = vim.uv.new_pipe(false)
local pending = ""
local loaded = false

-- Configure the named startup buffer before VimEnter so dashboards leave it alone.
vim.bo.buftype = "acwrite"
vim.bo.filetype = "markdown"

pipe:connect(socket_path, function(err)
  assert(not err, err)
  pipe:read_start(function(read_err, chunk)
    assert(not read_err, read_err)
    if not chunk or loaded then return end
    pending = pending .. chunk
    local newline = pending:find("\n", 1, true)
    if not newline then return end
    loaded = true
    local text = vim.json.decode(pending:sub(1, newline - 1)).text
    vim.schedule(function()
      vim.api.nvim_buf_set_lines(0, 0, -1, false, vim.split(text, "\n", { plain = true }))
      vim.bo.modified = false
      vim.cmd("startinsert")
    end)
  end)
end)

vim.api.nvim_create_autocmd("BufWriteCmd", {
  buffer = 0,
  callback = function()
    local text = table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), "\n")
    local sent, write_error = false, nil
    pipe:write(vim.json.encode({ text = text }) .. "\n", function(err)
      write_error = err
      sent = true
    end)
    if not vim.wait(2000, function() return sent end, 10) or write_error then
      error(write_error or "Timed out sending feedback to Pi")
    end
    vim.bo.modified = false
  end,
})

vim.api.nvim_create_autocmd("VimLeavePre", {
  callback = function()
    if not pipe:is_closing() then pipe:close() end
  end,
})
