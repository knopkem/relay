import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { WriteGuard } from "../write-guard.js"

const makeDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "write-guard-"))

const before = async (plugin, command) => {
  const args = { command }
  await plugin["tool.execute.before"]({ tool: "bash", sessionID: "wg" }, { args })
  return args
}

test("write guard: cat heredoc inside the project is applied and rerouted", async () => {
  const dir = makeDir()
  const plugin = await WriteGuard({ directory: dir })
  const args = await before(plugin, "cat > src/a.txt <<'EOF'\nhello\nworld\nEOF")
  assert.equal(fs.readFileSync(path.join(dir, "src/a.txt"), "utf8"), "hello\nworld\n")
  assert.match(args.command, /^echo /)
  assert.match(args.command, /wrote src\/a\.txt \(12 bytes\)/)
  assert.doesNotMatch(args.command, /cat/)
})

test("write guard: cat append heredoc appends", async () => {
  const dir = makeDir()
  fs.writeFileSync(path.join(dir, "log.txt"), "first\n")
  const plugin = await WriteGuard({ directory: dir })
  await before(plugin, "cat >> log.txt <<'EOF'\nsecond\nEOF")
  assert.equal(fs.readFileSync(path.join(dir, "log.txt"), "utf8"), "first\nsecond\n")
})

test("write guard: tee heredoc is applied", async () => {
  const dir = makeDir()
  const plugin = await WriteGuard({ directory: dir })
  await before(plugin, "tee out.txt <<'EOF'\ntee body\nEOF")
  assert.equal(fs.readFileSync(path.join(dir, "out.txt"), "utf8"), "tee body\n")
})

test("write guard: quoted marker keeps expansion characters literal", async () => {
  const dir = makeDir()
  const plugin = await WriteGuard({ directory: dir })
  const body = "$HOME `whoami` \\n"
  await before(plugin, `cat > v.txt <<'EOF'\n${body}\nEOF`)
  assert.equal(fs.readFileSync(path.join(dir, "v.txt"), "utf8"), `${body}\n`)
})

test("write guard: unquoted heredoc with expansions is blocked", async () => {
  const dir = makeDir()
  const plugin = await WriteGuard({ directory: dir })
  await assert.rejects(() => before(plugin, "cat > f.txt <<EOF\n$HOME\nEOF"), /expansions/)
  assert.equal(fs.existsSync(path.join(dir, "f.txt")), false)
})

test("write guard: inline interpreter writes are blocked", async () => {
  const dir = makeDir()
  const plugin = await WriteGuard({ directory: dir })
  await assert.rejects(
    () => before(plugin, "python3 - <<'PY'\nopen('x.txt', 'w').write('y')\nPY"),
    /write\/edit tool/,
  )
  assert.equal(fs.existsSync(path.join(dir, "x.txt")), false)
})

test("write guard: in-place editors are blocked", async () => {
  const plugin = await WriteGuard({ directory: makeDir() })
  await assert.rejects(() => before(plugin, "sed -i 's/a/b/' src/a.txt"), /edit tool/)
})

test("write guard: compound heredoc writes are blocked", async () => {
  const plugin = await WriteGuard({ directory: makeDir() })
  await assert.rejects(() => before(plugin, "cat > f.txt <<'EOF' && echo ok\nhi\nEOF"), /compound/)
})

test("write guard: writes outside the project are left alone", async () => {
  const project = makeDir()
  const outside = makeDir()
  const file = path.join(outside, "x.txt")
  const plugin = await WriteGuard({ directory: project })
  const command = `cat > ${file} <<'EOF'\nhi\nEOF`
  const args = await before(plugin, command)
  assert.equal(args.command, command)
  assert.equal(fs.existsSync(file), false)
})

test("write guard: heredoc to stdout is left alone", async () => {
  const plugin = await WriteGuard({ directory: makeDir() })
  const command = "cat <<'EOF'\njust text\nEOF"
  assert.equal((await before(plugin, command)).command, command)
})

test("write guard: non-write bash and other tools pass through", async () => {
  const plugin = await WriteGuard({ directory: makeDir() })
  const command = "cargo build 2>&1 | tail -5"
  assert.equal((await before(plugin, command)).command, command)
  const args = { command: "untouched" }
  await plugin["tool.execute.before"]({ tool: "edit", sessionID: "wg" }, { args })
  assert.equal(args.command, "untouched")
})

test("write guard: OCODESA_WRITE_GUARD=off disables the hooks", async () => {
  const previous = process.env.OCODESA_WRITE_GUARD
  process.env.OCODESA_WRITE_GUARD = "off"
  try {
    const plugin = await WriteGuard({ directory: makeDir() })
    assert.equal(plugin["tool.execute.before"], undefined)
  } finally {
    if (previous === undefined) delete process.env.OCODESA_WRITE_GUARD
    else process.env.OCODESA_WRITE_GUARD = previous
  }
})
