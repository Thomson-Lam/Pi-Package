local Client = {}
Client.__index = Client

local MAX_FRAME = 256 * 1024

function Client.new(options)
  local self = setmetatable({}, Client)
  self.socket_path = assert(options.socket_path)
  self.review_id = assert(options.review_id)
  self.on_message = assert(options.on_message)
  self.on_disconnect = options.on_disconnect or function() end
  self.pipe = vim.uv.new_pipe(false)
  self.buffer = ""
  self.closed = false
  self.counter = 0
  return self
end

function Client:connect(callback)
  self.pipe:connect(self.socket_path, function(error)
    if error then vim.schedule(function() callback(error) end); return end
    self.pipe:read_start(function(read_error, chunk)
      if read_error then self:close(); return end
      if not chunk then self:close(); return end
      self.buffer = self.buffer .. chunk
      if #self.buffer > MAX_FRAME and not self.buffer:find("\n", 1, true) then self:close(); return end
      while true do
        local newline = self.buffer:find("\n", 1, true)
        if not newline then break end
        local line = self.buffer:sub(1, newline - 1)
        self.buffer = self.buffer:sub(newline + 1)
        if #line > MAX_FRAME then self:close(); return end
        if line ~= "" then
          local ok, message = pcall(vim.json.decode, line)
          if not ok or type(message) ~= "table" or message.protocolVersion ~= 2 or message.reviewId ~= self.review_id or type(message.type) ~= "string" then
            self:close(); return
          end
          vim.schedule(function() self.on_message(message) end)
        end
      end
    end)
    vim.schedule(function() callback(nil) end)
  end)
end

function Client:send(kind, payload, request_id)
  if self.closed then return nil end
  self.counter = self.counter + 1
  local id = request_id or string.format("nvim-%d-%d", vim.uv.hrtime(), self.counter)
  local message = {
    protocolVersion = 2,
    type = kind,
    reviewId = self.review_id,
    requestId = id,
    payload = payload or {},
  }
  self.pipe:write(vim.json.encode(message) .. "\n")
  return id
end

function Client:close()
  if self.closed then return end
  self.closed = true
  if self.pipe and not self.pipe:is_closing() then
    self.pipe:read_stop()
    self.pipe:close()
  end
  vim.schedule(self.on_disconnect)
end

return Client
