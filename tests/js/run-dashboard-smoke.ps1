[CmdletBinding()]
param(
    [int] $DashboardPort = 0,
    [int] $DebugPort = 0,
    [string] $EdgePath = ""
)

$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$TempRoot = [IO.Path]::GetFullPath($env:TEMP)
$Token = [guid]::NewGuid().ToString("N")
$ArtifactPrefix = "codex-usage-dashboard-smoke-$Token"
$ProfilePath = Join-Path $TempRoot $ArtifactPrefix
$DashboardOutPath = Join-Path $TempRoot "$ArtifactPrefix-dashboard.out.log"
$DashboardErrPath = Join-Path $TempRoot "$ArtifactPrefix-dashboard.err.log"
$EdgeOutPath = Join-Path $TempRoot "$ArtifactPrefix-edge.out.log"
$EdgeErrPath = Join-Path $TempRoot "$ArtifactPrefix-edge.err.log"
$CharacterRegistryPath = Join-Path $TempRoot "$ArtifactPrefix-character-registry"
$DashboardProcess = $null
$EdgeProcess = $null
$CdpSocket = $null
$CdpCommandId = 0
$Checks = New-Object System.Collections.Generic.List[string]

function Resolve-SmokePython {
    if ($env:CODEX_USAGE_PYTHON) {
        return [PSCustomObject]@{ Executable = $env:CODEX_USAGE_PYTHON; PrefixArgs = @() }
    }

    $Py = Get-Command "py.exe" -ErrorAction SilentlyContinue
    if (-not $Py) { $Py = Get-Command "py" -ErrorAction SilentlyContinue }
    if ($Py) {
        return [PSCustomObject]@{ Executable = $Py.Source; PrefixArgs = @("-3") }
    }

    $Python = Get-Command "python.exe" -ErrorAction SilentlyContinue
    if (-not $Python) { $Python = Get-Command "python" -ErrorAction SilentlyContinue }
    if ($Python) {
        return [PSCustomObject]@{ Executable = $Python.Source; PrefixArgs = @() }
    }

    throw "Python 3 não encontrado para iniciar o dashboard sem VENV."
}

function Resolve-SmokeEdge {
    if ($EdgePath) {
        if (-not (Test-Path -LiteralPath $EdgePath -PathType Leaf)) {
            throw "Microsoft Edge não encontrado em $EdgePath."
        }
        return (Resolve-Path -LiteralPath $EdgePath).Path
    }

    $Candidates = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
    )
    $Resolved = $Candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $Resolved) {
        throw "Microsoft Edge não encontrado para executar o smoke E2E."
    }
    return $Resolved
}

function Resolve-FreePort([int] $RequestedPort) {
    if ($RequestedPort -gt 0) { return $RequestedPort }
    $Listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $Listener.Start()
        return ([Net.IPEndPoint] $Listener.LocalEndpoint).Port
    }
    finally {
        $Listener.Stop()
    }
}

function Wait-HttpOk([string] $Url, [System.Diagnostics.Process] $Process, [int] $Attempts = 80) {
    for ($Attempt = 0; $Attempt -lt $Attempts; $Attempt += 1) {
        if ($Process -and $Process.HasExited) {
            throw "Processo encerrou antes de responder em $Url."
        }
        try {
            $Response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 1
            if ($Response.StatusCode -eq 200) { return }
        }
        catch {
            Start-Sleep -Milliseconds 100
        }
    }
    throw "Timeout aguardando $Url."
}

function Connect-Cdp([string] $WebSocketUrl) {
    $script:CdpSocket = [Net.WebSockets.ClientWebSocket]::new()
    $Cancellation = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(10))
    try {
        $Uri = [Uri] $WebSocketUrl
        try {
            $null = $script:CdpSocket.ConnectAsync($Uri, $Cancellation.Token).GetAwaiter().GetResult()
        }
        catch {
            $Details = $_.Exception.Message
            if ($_.Exception.InnerException) { $Details += " | $($_.Exception.InnerException.Message)" }
            throw "Falha no handshake CDP em $($Uri.Host):$($Uri.Port): $Details"
        }
    }
    finally {
        $Cancellation.Dispose()
    }
}

function Receive-CdpMessage {
    $Buffer = New-Object byte[] 65536
    $Stream = [IO.MemoryStream]::new()
    try {
        do {
            $Segment = [ArraySegment[byte]]::new($Buffer)
            $Cancellation = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(15))
            try {
                $Receive = $script:CdpSocket.ReceiveAsync($Segment, $Cancellation.Token).GetAwaiter().GetResult()
            }
            finally {
                $Cancellation.Dispose()
            }
            if ($Receive.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) {
                throw "Conexão CDP encerrada pelo Edge."
            }
            $Stream.Write($Buffer, 0, $Receive.Count)
        } until ($Receive.EndOfMessage)

        $Text = [Text.Encoding]::UTF8.GetString($Stream.ToArray())
        return ($Text | ConvertFrom-Json)
    }
    finally {
        $Stream.Dispose()
    }
}

function Invoke-CdpCommand([string] $Method, [hashtable] $Params = @{}) {
    $script:CdpCommandId += 1
    $CommandId = $script:CdpCommandId
    $Payload = [ordered]@{ id = $CommandId; method = $Method }
    if ($Params.Count -gt 0) { $Payload.params = $Params }
    $Json = $Payload | ConvertTo-Json -Depth 40 -Compress
    $Bytes = [Text.Encoding]::UTF8.GetBytes($Json)
    $Segment = [ArraySegment[byte]]::new($Bytes)
    $Cancellation = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(10))
    try {
        $null = $script:CdpSocket.SendAsync(
            $Segment,
            [Net.WebSockets.WebSocketMessageType]::Text,
            $true,
            $Cancellation.Token
        ).GetAwaiter().GetResult()
    }
    finally {
        $Cancellation.Dispose()
    }

    while ($true) {
        $Message = Receive-CdpMessage
        if ($Message.id -ne $CommandId) { continue }
        if ($Message.error) {
            throw "CDP $Method falhou: $($Message.error.message)"
        }
        return $Message.result
    }
}

function Invoke-CdpExpression([string] $Expression) {
    $Response = Invoke-CdpCommand "Runtime.evaluate" @{
        expression = $Expression
        returnByValue = $true
        awaitPromise = $true
        userGesture = $true
    }
    if ($Response.exceptionDetails) {
        $Description = $Response.exceptionDetails.exception.description
        if (-not $Description) { $Description = $Response.exceptionDetails.text }
        throw "JavaScript no dashboard falhou: $Description"
    }
    return $Response.result.value
}

function Wait-CdpCondition([string] $Expression, [int] $TimeoutMilliseconds = 10000) {
    $Deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    do {
        if (Invoke-CdpExpression $Expression) { return }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $Deadline)
    throw "Timeout aguardando condição do dashboard: $Expression"
}

function Wait-UiSettled {
    $null = Invoke-CdpExpression @'
new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve(true), 220))))
'@
}

function Set-Viewport([int] $Width, [int] $Height) {
    $null = Invoke-CdpCommand "Emulation.setDeviceMetricsOverride" @{
        width = $Width
        height = $Height
        deviceScaleFactor = 1
        mobile = $false
        screenWidth = $Width
        screenHeight = $Height
    }
    $null = Invoke-CdpExpression "window.scrollTo(0, 0); window.dispatchEvent(new Event('resize')); true"
    Wait-CdpCondition "window.innerWidth === $Width && window.innerHeight === $Height"
    Wait-UiSettled
}

function Set-Checkbox([string] $Id, [bool] $Checked) {
    $IdJson = $Id | ConvertTo-Json -Compress
    $CheckedJson = if ($Checked) { "true" } else { "false" }
    $Expression = @"
(() => {
  const element = document.getElementById($IdJson);
  if (!element) throw new Error("Controle ausente: " + $IdJson);
  element.checked = $CheckedJson;
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return element.checked === $CheckedJson;
})()
"@
    if (-not (Invoke-CdpExpression $Expression)) {
        throw "Controle $Id não assumiu o valor $Checked."
    }
    Wait-UiSettled
}

function Set-SpriteCount([int] $Count) {
    $Expression = @"
(() => {
  const element = document.getElementById("spriteCountInput");
  element.value = "$Count";
  element.dispatchEvent(new Event("input", { bubbles: true }));
  return Number(element.value);
})()
"@
    $Actual = Invoke-CdpExpression $Expression
    if ([int] $Actual -ne $Count) { throw "Controle de quantidade não aceitou $Count." }
    Wait-CdpCondition "document.querySelectorAll('.sprite-companion').length === $Count"
    Wait-UiSettled
}

function Add-Check([string] $Name) {
    $Checks.Add($Name) | Out-Null
}

function Assert-Condition([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}

function Get-GeometryResult {
    return Invoke-CdpExpression @'
(() => {
  const visible = element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0
      && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < innerWidth
      && rect.bottom > 0 && rect.top < innerHeight;
  };
  const coreRect = rect => {
    const padding = rect.width * 0.12;
    return {
      left: rect.left + padding,
      top: rect.top + padding,
      right: rect.right - padding,
      bottom: rect.bottom - padding * 0.45,
    };
  };
  const overlapArea = (left, right) => Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left))
    * Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  const spriteElements = [...document.querySelectorAll(".sprite-companion")].filter(visible);
  const sprites = spriteElements.map((element, index) => ({ index, rect: element.getBoundingClientRect() }));
  const protectedRects = [...document.querySelectorAll("[data-sprite-protected]")]
    .filter(element => !document.getElementById("spriteWorld").contains(element) && visible(element))
    .map((element, index) => ({ index, rect: element.getBoundingClientRect() }));
  const errors = [];

  for (const sprite of sprites) {
    const rect = sprite.rect;
    if (rect.left < -0.5 || rect.top < -0.5 || rect.right > innerWidth + 0.5 || rect.bottom > innerHeight + 0.5) {
      errors.push(`sprite ${sprite.index + 1} fora do viewport`);
    }
    const core = coreRect(rect);
    for (const protectedItem of protectedRects) {
      if (overlapArea(core, protectedItem.rect) > 0.5) {
        errors.push(`sprite ${sprite.index + 1} sobrepõe área protegida ${protectedItem.index + 1}`);
      }
    }
  }

  for (let left = 0; left < sprites.length; left += 1) {
    for (let right = left + 1; right < sprites.length; right += 1) {
      if (overlapArea(coreRect(sprites[left].rect), coreRect(sprites[right].rect)) > 0.5) {
        errors.push(`sprites ${left + 1} e ${right + 1} colidem`);
      }
    }
  }

  const visibleBubbles = spriteElements.filter(element => {
    const bubble = element.querySelector(".sprite-bubble");
    return bubble && visible(bubble) && Number(getComputedStyle(bubble).opacity) > 0.05;
  }).length;
  if (visibleBubbles > 1) errors.push(`${visibleBubbles} balões visíveis simultaneamente`);
  const animationProblems = spriteElements.filter(element => {
    const status = element.querySelector(".sprite-body")?.dataset.animationStatus;
    return status !== "ready" && status !== "fallback";
  }).length;
  if (animationProblems) errors.push(`${animationProblems} animações sem preload`);
  if (Math.abs(scrollX) > 0.5) errors.push(`scrollX=${scrollX}`);

  return {
    width: innerWidth,
    height: innerHeight,
    spriteCount: sprites.length,
    visibleBubbles,
    scrollX,
    errors,
  };
})()
'@
}

function Get-SpritePositions {
    return @(Invoke-CdpExpression @'
[...document.querySelectorAll(".sprite-companion")].map(element => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top };
})
'@)
}

function Convert-PositionsToJson($Positions) {
    return @($Positions) | ConvertTo-Json -Depth 5 -Compress
}

function Get-MaxDisplacement($Before) {
    $BeforeJson = Convert-PositionsToJson $Before
    return [double] (Invoke-CdpExpression @"
(() => {
  const before = $BeforeJson;
  const current = [...document.querySelectorAll(".sprite-companion")].map(element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  });
  if (before.length !== current.length) return Number.POSITIVE_INFINITY;
  return current.reduce((maximum, item, index) => Math.max(maximum, Math.hypot(item.x - before[index].x, item.y - before[index].y)), 0);
})()
"@)
}

function Wait-ForMovement($Before, [int] $TimeoutMilliseconds = 6500) {
    $Deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    do {
        if ((Get-MaxDisplacement $Before) -gt 2) { return }
        Start-Sleep -Milliseconds 120
    } while ([DateTime]::UtcNow -lt $Deadline)
    $Diagnostic = Invoke-CdpExpression @'
(() => ({
  movement: document.getElementById("spriteMovementInput").checked,
  roam: document.getElementById("spriteRoamInput").checked,
  reactions: document.getElementById("spriteSmartInput").checked,
  reducedMotion: document.getElementById("spriteWorld").dataset.reducedMotion,
  visibility: document.visibilityState,
  errors: window.__dashboardSmokeErrors || [],
  sprites: [...document.querySelectorAll(".sprite-companion")].map(element => ({
    state: element.dataset.state,
    transform: element.style.transform,
  })),
}))()
'@
    throw "Sprites não se moveram após habilitar movimento livre. Estado: $($Diagnostic | ConvertTo-Json -Depth 5 -Compress)"
}

function Test-GeometryMatrix {
    Set-Checkbox "spriteSpeechInput" $false
    Set-Checkbox "spriteMovementInput" $false
    Set-Checkbox "spriteRoamInput" $false
    Set-Checkbox "spriteSmartInput" $false

    $Viewports = @(
        @{ Width = 1440; Height = 900 },
        @{ Width = 760; Height = 900 },
        @{ Width = 390; Height = 844 }
    )
    foreach ($Viewport in $Viewports) {
        Set-Viewport $Viewport.Width $Viewport.Height
        foreach ($Count in 1..3) {
            Set-SpriteCount $Count
            $Geometry = Get-GeometryResult
            Assert-Condition ($Geometry.spriteCount -eq $Count) "Viewport $($Viewport.Width)x$($Viewport.Height): esperado $Count sprites, recebido $($Geometry.spriteCount)."
            Assert-Condition ($Geometry.errors.Count -eq 0) "Viewport $($Viewport.Width)x$($Viewport.Height), $Count sprites: $($Geometry.errors -join '; ')."
            Add-Check "geometria $($Viewport.Width)x$($Viewport.Height) com $Count sprite(s)"
        }
    }
}

function Test-Toggles {
    Set-Viewport 760 900
    Set-SpriteCount 3
    Set-Checkbox "spriteRoamInput" $false
    Set-Checkbox "spriteMovementInput" $false
    Set-Checkbox "spriteSpeechInput" $true
    Set-Checkbox "spriteSmartInput" $false

    Wait-CdpCondition "document.querySelectorAll('.sprite-companion.talking').length === 0"
    Set-Checkbox "spriteSmartInput" $true
    Wait-CdpCondition "document.querySelectorAll('.sprite-companion.talking').length === 1" 4500
    $BubbleCount = [int] (Invoke-CdpExpression "document.querySelectorAll('.sprite-companion.talking').length")
    Assert-Condition ($BubbleCount -le 1) "Mais de um balão foi exibido após habilitar reações."
    $BubbleGeometry = Invoke-CdpExpression @'
(() => {
  const bubble = document.querySelector(".sprite-companion.talking .sprite-bubble");
  if (!bubble) return { total: 0, bubble: null, overlaps: [] };
  const bubbleRect = bubble.getBoundingClientRect();
  const overlap = (left, right) => Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left))
    * Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  const overlaps = [...document.querySelectorAll("[data-sprite-protected], .progress, .machine-bars")]
    .filter(element => !document.getElementById("spriteWorld").contains(element))
    .map(element => ({
      selector: element.id ? `#${element.id}` : element.className,
      area: overlap(bubbleRect, element.getBoundingClientRect()),
    }))
    .filter(item => item.area > 0.5);
  return {
    total: overlaps.reduce((total, item) => total + item.area, 0),
    bubble: { left: bubbleRect.left, top: bubbleRect.top, right: bubbleRect.right, bottom: bubbleRect.bottom },
    placement: {
      spriteClass: bubble.closest(".sprite-companion").className,
      shiftX: getComputedStyle(bubble.closest(".sprite-companion")).getPropertyValue("--bubble-shift-x"),
      shiftY: getComputedStyle(bubble.closest(".sprite-companion")).getPropertyValue("--bubble-shift-y"),
      transform: getComputedStyle(bubble).transform,
      left: getComputedStyle(bubble).left,
      right: getComputedStyle(bubble).right,
      top: getComputedStyle(bubble).top,
      bottom: getComputedStyle(bubble).bottom,
    },
    overlaps,
  };
})()
'@
    Assert-Condition ($BubbleGeometry.total -le 0.5) "Balão contextual sobrepôs conteúdo protegido: $($BubbleGeometry | ConvertTo-Json -Depth 6 -Compress)."
    Add-Check "toggle de reações e limite de um balão"

    Set-Checkbox "spriteSpeechInput" $false
    Wait-CdpCondition "document.querySelectorAll('.sprite-companion.talking').length === 0"
    Start-Sleep -Milliseconds 700
    $SpeechOff = Invoke-CdpExpression "!document.getElementById('spriteSpeechInput').checked && document.querySelectorAll('.sprite-companion.talking').length === 0"
    Assert-Condition ([bool] $SpeechOff) "Desativar falas não removeu ou não suprimiu balões."
    Add-Check "toggle de falas"

    Set-Checkbox "spriteSmartInput" $false
    Set-Checkbox "spriteRoamInput" $true
    Set-Checkbox "spriteMovementInput" $true
    Set-SpriteCount 2
    Set-SpriteCount 3
    $BeforeMovement = Get-SpritePositions
    Wait-ForMovement $BeforeMovement
    Add-Check "movimento habilitado"

    Set-Checkbox "spriteMovementInput" $false
    $Stopped = Get-SpritePositions
    Start-Sleep -Milliseconds 900
    $StoppedDisplacement = Get-MaxDisplacement $Stopped
    Assert-Condition ($StoppedDisplacement -le 1) "Sprites continuaram se deslocando com movimento desativado: $StoppedDisplacement px."
    Add-Check "toggle de movimento"

    Set-Checkbox "spriteRoamInput" $false
    Set-Checkbox "spriteSpeechInput" $true
}

function Test-ReducedMotion {
    Set-Viewport 390 844
    Set-SpriteCount 3
    Set-Checkbox "spriteSmartInput" $false
    Set-Checkbox "spriteSpeechInput" $false
    Set-Checkbox "spriteRoamInput" $true
    Set-Checkbox "spriteMovementInput" $true

    $null = Invoke-CdpCommand "Emulation.setEmulatedMedia" @{
        features = @(@{ name = "prefers-reduced-motion"; value = "reduce" })
    }
    Wait-CdpCondition "document.getElementById('spriteWorld').dataset.reducedMotion === 'true'"
    Wait-CdpCondition "[...document.querySelectorAll('.sprite-body')].every(item => item.dataset.animationReducedMotion === 'true' && item.dataset.animationFrame === '0')"
    Wait-UiSettled

    $Reduced = Invoke-CdpExpression @'
(() => {
  const world = document.getElementById("spriteWorld");
  const style = getComputedStyle(world);
  const nodes = [...world.querySelectorAll(".sprite-companion, .sprite-companion *")];
  return {
    visible: style.display !== "none" && style.visibility !== "hidden" && !world.classList.contains("hidden"),
    animationsNone: nodes.every(node => getComputedStyle(node).animationName === "none"),
    count: world.querySelectorAll(".sprite-companion").length,
  };
})()
'@
    Assert-Condition ([bool] $Reduced.visible) "prefers-reduced-motion ocultou o mundo de sprites."
    Assert-Condition ([bool] $Reduced.animationsNone) "Há animações CSS ativas com prefers-reduced-motion."
    Assert-Condition ($Reduced.count -eq 3) "Quantidade de sprites mudou em prefers-reduced-motion."
    $Before = Get-SpritePositions
    Start-Sleep -Milliseconds 800
    Assert-Condition ((Get-MaxDisplacement $Before) -le 1) "Sprites se deslocaram em prefers-reduced-motion."
    Add-Check "prefers-reduced-motion visível e estático"

    $null = Invoke-CdpCommand "Emulation.setEmulatedMedia" @{ features = @() }
    Wait-CdpCondition "document.getElementById('spriteWorld').dataset.reducedMotion === 'false'"
}

function Test-Drag {
    Set-Viewport 1440 900
    Set-SpriteCount 1
    Set-Checkbox "spriteSmartInput" $false
    Set-Checkbox "spriteSpeechInput" $false
    Set-Checkbox "spriteRoamInput" $false
    Set-Checkbox "spriteMovementInput" $false

    $DragPlan = Invoke-CdpExpression @'
(() => {
  const sprite = document.querySelector(".sprite-companion");
  if (!sprite) return null;
  const rect = sprite.getBoundingClientRect();
  const core = candidate => {
    const padding = rect.width * 0.12;
    return {
      left: candidate.x + padding,
      top: candidate.y + padding,
      right: candidate.x + rect.width - padding,
      bottom: candidate.y + rect.height - padding * 0.45,
    };
  };
  const overlap = (left, right) => Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left))
    * Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  const protectedRects = [...document.querySelectorAll("[data-sprite-protected]")]
    .filter(element => {
      const item = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && item.width > 0 && item.height > 0
        && item.right > 0 && item.left < innerWidth && item.bottom > 0 && item.top < innerHeight;
    })
    .map(element => element.getBoundingClientRect());
  const maxX = innerWidth - rect.width - 6;
  const maxY = innerHeight - rect.height - 6;
  const candidates = [
    { x: 6, y: 48 }, { x: maxX, y: 48 }, { x: 6, y: maxY }, { x: maxX, y: maxY },
    { x: rect.left + 180, y: rect.top }, { x: rect.left - 180, y: rect.top },
    { x: rect.left, y: rect.top + 180 }, { x: rect.left, y: rect.top - 180 },
  ];
  for (let y = 48; y <= maxY; y += 72) {
    for (let x = 6; x <= maxX; x += 72) candidates.push({ x, y });
  }
  const safeCandidates = candidates
    .map(candidate => ({
      x: Math.max(6, Math.min(maxX, candidate.x)),
      y: Math.max(48, Math.min(maxY, candidate.y)),
    }))
    .filter(candidate => Math.hypot(candidate.x - rect.left, candidate.y - rect.top) >= 30)
    .filter(candidate => !protectedRects.some(item => overlap(core(candidate), item) > 0.5))
    .sort((left, right) => Math.hypot(right.x - rect.left, right.y - rect.top) - Math.hypot(left.x - rect.left, left.y - rect.top));
  const candidate = safeCandidates[0];
  if (candidate) {
    return {
      fromX: rect.left + rect.width / 2,
      fromY: rect.top + rect.height / 2,
      toX: candidate.x + rect.width / 2,
      toY: candidate.y + rect.height / 2,
      startLeft: rect.left,
      startTop: rect.top,
    };
  }
  return null;
})()
'@
    if (-not $DragPlan) {
        Add-Check "arraste ignorado: nenhum destino seguro"
        return
    }

    $null = Invoke-CdpCommand "Input.dispatchMouseEvent" @{
        type = "mouseMoved"; x = [double] $DragPlan.fromX; y = [double] $DragPlan.fromY
    }
    $null = Invoke-CdpCommand "Input.dispatchMouseEvent" @{
        type = "mousePressed"; x = [double] $DragPlan.fromX; y = [double] $DragPlan.fromY
        button = "left"; buttons = 1; clickCount = 1
    }
    foreach ($Step in 1..5) {
        $Progress = $Step / 5.0
        $X = [double] $DragPlan.fromX + ([double] $DragPlan.toX - [double] $DragPlan.fromX) * $Progress
        $Y = [double] $DragPlan.fromY + ([double] $DragPlan.toY - [double] $DragPlan.fromY) * $Progress
        $null = Invoke-CdpCommand "Input.dispatchMouseEvent" @{
            type = "mouseMoved"; x = $X; y = $Y; button = "left"; buttons = 1
        }
    }
    $null = Invoke-CdpCommand "Input.dispatchMouseEvent" @{
        type = "mouseReleased"; x = [double] $DragPlan.toX; y = [double] $DragPlan.toY
        button = "left"; buttons = 0; clickCount = 1
    }
    Wait-UiSettled
    $Moved = Invoke-CdpExpression @"
(() => {
  const rect = document.querySelector(".sprite-companion").getBoundingClientRect();
  return Math.hypot(rect.left - $($DragPlan.startLeft), rect.top - $($DragPlan.startTop));
})()
"@
    Assert-Condition ([double] $Moved -gt 20) "Arraste não moveu o sprite: deslocamento de $Moved px."
    Add-Check "arraste por ponteiro"
}

function Test-BehaviorStudio {
    Set-Viewport 1440 900
    Wait-CdpCondition "document.getElementById('behaviorStudioStatus').textContent !== 'Carregando configuração…'" 10000
    $null = Invoke-CdpExpression "document.getElementById('openBehaviorStudio').click(); true"
    Wait-CdpCondition "document.getElementById('behaviorStudio').classList.contains('open')"
    Wait-UiSettled

    $Structure = Invoke-CdpExpression @'
(() => ({
  tabs: document.querySelectorAll("[data-behavior-tab]").length,
  visiblePanel: document.querySelectorAll("[data-behavior-panel]:not([hidden])").length,
  rules: document.querySelectorAll(".behavior-rule-card").length,
  cardsBehind: document.querySelectorAll(".ambient-card, .usage-card").length,
  dialogRole: document.getElementById("behaviorStudio").getAttribute("role"),
  status: document.getElementById("behaviorStudioStatus").textContent,
}))()
'@
    Assert-Condition ($Structure.tabs -eq 7) "Studio não exibiu as sete abas obrigatórias."
    Assert-Condition ($Structure.visiblePanel -eq 1) "Studio exibiu mais de um painel de aba."
    Assert-Condition ($Structure.rules -gt 0) "Lista de comportamentos ficou vazia. Status: $($Structure.status)"
    Assert-Condition ($Structure.cardsBehind -eq 6) "Dashboard principal foi alterado ao abrir o Studio."
    Assert-Condition ($Structure.dialogRole -eq "dialog") "Studio não expôs semântica de diálogo."
    Add-Check "Studio abre sobre dashboard preservado com sete abas"

    $null = Invoke-CdpExpression "document.querySelector('[data-behavior-tab=characters]').click(); true"
    Wait-CdpCondition "!document.getElementById('behaviorPanelCharacters').hidden && document.querySelectorAll('[data-character-id]').length >= 5" 12000
    Wait-CdpCondition "document.querySelector('[data-character-preview-sprite]')?.dataset.animationStatus === 'ready'" 12000
    $Characters = Invoke-CdpExpression @'
(() => ({
  total: document.querySelectorAll("[data-character-id]").length,
  sentinel: Boolean(document.querySelector('[data-character-id="sentinel"]')),
  preview: document.querySelector("[data-character-preview-sprite]")?.dataset.animationStatus,
  stateControl: Boolean(document.querySelector('[data-character-control="preview-state"]')),
  fpsControl: Boolean(document.querySelector('[data-character-control="preview-fps"]')),
  packageInput: Boolean(document.querySelector('[data-character-control="package-file"]')),
  validateAction: Boolean(document.querySelector('[data-character-action="validate-package"]')),
  restoreAction: Boolean(document.querySelector('[data-character-action="restore-natives"]')),
}))()
'@
    Assert-Condition ($Characters.total -ge 5 -and [bool] $Characters.sentinel) "Aba Personagens não listou nativos e o pacote Sentinela."
    Assert-Condition ($Characters.preview -eq "ready" -and [bool] $Characters.stateControl -and [bool] $Characters.fpsControl) "Preview da aba Personagens não ficou pronto."
    Assert-Condition ([bool] $Characters.packageInput -and [bool] $Characters.validateAction -and [bool] $Characters.restoreAction) "Controles de pacote da aba Personagens estão incompletos."
    Add-Check "biblioteca de personagens e pacote real instalado"
    Add-Check "preview e diagnóstico da aba Personagens"
    Add-Check "importação, validação e restauração de pacotes disponíveis"

    $Filters = Invoke-CdpExpression @'
(() => {
  const change = (selector, value) => { const element = document.querySelector(selector); element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); };
  const preview = document.querySelector("[data-character-preview-sprite]")?.dataset.animationStatus;
  change('[data-character-control="source"]', "bundled");
  change('[data-character-control="tag"]', "pokemon");
  change('[data-character-control="personality"]', "humorous");
  const visible = [...document.querySelectorAll("[data-character-id]")].map(item => item.dataset.characterId);
  document.querySelector('[data-character-action="clear-filters"]')?.click();
  return { visible, cleared: document.querySelector('[data-character-control="tag"]')?.value === "", preview };
})()
'@
    Assert-Condition (($Filters.visible -join ",") -eq "gengar") "Filtros combinados bundled/pokemon/humorous não retornaram Gengar: $($Filters | ConvertTo-Json -Compress)"
    Assert-Condition ([bool] $Filters.cleared -and $Filters.preview -eq "ready") "Limpeza de filtros ou lazy preview falhou."
    Add-Check "filtros por origem, tag, personalidade e limpeza preservam preview lazy"

    $null = Invoke-CdpExpression "document.querySelector('[data-character-id=sentinel]').click(); true"
    Wait-CdpCondition "document.querySelector('[data-character-detail] h3')?.textContent.includes('Sentinela')"
    $null = Invoke-CdpExpression "document.querySelector('[data-character-action=toggle]').click(); true"
    Wait-CdpCondition "document.querySelector('[data-character-action=toggle]')?.textContent.includes('Ativar') && ![...document.querySelectorAll('#spriteCharacterOptions [data-sprite]')].some(item => item.dataset.sprite === 'sentinel')" 12000
    $null = Invoke-CdpExpression "document.querySelector('[data-character-action=toggle]').click(); true"
    Wait-CdpCondition "document.querySelector('[data-character-action=toggle]')?.textContent.includes('Desativar') && [...document.querySelectorAll('#spriteCharacterOptions [data-sprite]')].some(item => item.dataset.sprite === 'sentinel')" 12000
    Add-Check "ativação de pacote sincroniza catálogo, motor e aparência"

    $null = Invoke-CdpExpression "document.querySelector('[data-behavior-tab=behaviors]').click(); true"
    Wait-CdpCondition "!document.getElementById('behaviorPanelBehaviors').hidden && document.querySelector('[data-action=new-trigger]')"

    $Crud = Invoke-CdpExpression @'
(() => {
  const before = document.querySelectorAll(".behavior-rule-card").length;
  document.querySelector('[data-action="new-trigger"]').click();
  const form = document.querySelector('[data-studio-form="trigger"]');
  const id = form?.querySelector('[name="id"]')?.value;
  form?.querySelector('[data-action="add-condition"]')?.click();
  return {
    before,
    after: document.querySelectorAll(".behavior-rule-card").length,
    id,
    conditions: form?.querySelectorAll("[data-condition-row]").length || 0,
    hasCharacter: Boolean(form?.querySelector('[name="characterSelectorKind"]') && form?.querySelector('[name="characterSelectorValue"]')),
    hasRepeat: Boolean(form?.querySelector('[name="repeatWhileActive"]')),
  };
})()
'@
    Assert-Condition ($Crud.after -eq ($Crud.before + 1)) "Criação visual de gatilho não atualizou a lista."
    Assert-Condition ([bool] $Crud.id) "Novo gatilho não recebeu ID."
    Assert-Condition ($Crud.conditions -eq 2) "Editor visual não adicionou condição AND/OR."
    Assert-Condition ([bool] $Crud.hasCharacter -and [bool] $Crud.hasRepeat) "Campos de personagem/repetição ausentes."
    Add-Check "CRUD visual e editor de condições"

    Wait-CdpCondition "document.querySelector('[data-trigger-animation-preview] .animation-preview-sprite')?.dataset.animationStatus === 'ready'"
    $AnimationPreview = Invoke-CdpExpression @'
(async () => {
  const sprite = document.querySelector("[data-trigger-animation-preview] .animation-preview-sprite");
  const before = sprite.dataset.animationFrame;
  await new Promise(resolve => setTimeout(resolve, 650));
  const animated = sprite.dataset.animationFrame !== before;
  document.querySelector('[data-animation-action="pause"]').click();
  const pausedAt = sprite.dataset.animationFrame;
  await new Promise(resolve => setTimeout(resolve, 500));
  const paused = sprite.dataset.animationFrame === pausedAt;
  document.querySelector('[data-animation-action="play"]').click();
  await new Promise(resolve => setTimeout(resolve, 650));
  return {
    animated,
    paused,
    resumed: sprite.dataset.animationFrame !== pausedAt,
    status: sprite.dataset.animationStatus,
    fps: Number(sprite.dataset.animationFps),
    frames: Number(sprite.dataset.animationFrames),
    fallback: sprite.dataset.animationFallback,
    fallbackReason: sprite.dataset.animationFallbackReason,
    source: sprite.dataset.animationSource,
    asset: sprite.style.backgroundImage,
    diagnostic: sprite.closest('[data-trigger-animation-preview]')?.querySelector('[data-animation-diagnostic]')?.textContent || "",
  };
})()
'@
    Assert-Condition ([bool] $AnimationPreview.animated -and [bool] $AnimationPreview.paused -and [bool] $AnimationPreview.resumed) "Preview não animou/pausou/retomou: $($AnimationPreview | ConvertTo-Json -Compress)"
    Assert-Condition ($AnimationPreview.frames -ge 4 -and $AnimationPreview.fps -ge 1 -and [bool] $AnimationPreview.diagnostic) "Preview não exibiu frames, FPS ou diagnóstico."
    Add-Check "preview animado com play, pause, FPS e diagnóstico"

    $Fallback = Invoke-CdpExpression @'
(async () => {
  const module = await import("./character-registry.js");
  const resolution = await module.defaultCharacterRegistry.resolveState("explorer", "estado_inexistente");
  return { fallback: resolution.fallback, requested: resolution.requestedState, resolved: resolution.resolvedState, source: resolution.source };
})()
'@
    Assert-Condition ([bool] $Fallback.fallback -and $Fallback.resolved -eq "idle") "Fallback visual não resolveu estado ausente para idle: $($Fallback | ConvertTo-Json -Compress)"
    Add-Check "diagnóstico de fallback visual no Edge"

    $null = Invoke-CdpExpression "document.querySelector('[data-behavior-tab=speech]').click(); true"
    Wait-CdpCondition "!document.getElementById('behaviorPanelSpeech').hidden && document.querySelector('[data-studio-form=phrase]')"
    $Speech = Invoke-CdpExpression @'
(() => {
  const field = document.querySelector('[data-studio-form="phrase"] [data-speech-input]');
  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
  const macroButton = document.querySelector('[data-studio-form="phrase"] [data-action="insert-macro"]');
  const token = macroButton?.dataset.token;
  macroButton?.click();
  return {
    inserted: Boolean(token && field.value.includes(token)),
    preview: document.querySelector("[data-speech-preview]")?.textContent || "",
    validation: document.querySelector("[data-speech-errors]")?.textContent || "",
  };
})()
'@
    Assert-Condition ([bool] $Speech.inserted) "Clique em macro não a inseriu na fala."
    Assert-Condition ([bool] $Speech.preview) "Pré-visualização de fala ficou vazia."
    Assert-Condition ([bool] $Speech.validation) "Validação de macros não apresentou diagnóstico."
    Add-Check "falas, macro clicável e pré-visualização real"

    $null = Invoke-CdpExpression "document.querySelector('[data-behavior-tab=macros]').click(); true"
    Wait-CdpCondition "!document.getElementById('behaviorPanelMacros').hidden && document.querySelectorAll('.macro-card').length >= 16"
    $MacroColumns = Invoke-CdpExpression "Boolean(document.querySelector('.macro-card .macro-token') && document.querySelector('.macro-card .macro-value') && document.querySelector('.macro-card .behavior-chip'))"
    Assert-Condition ([bool] $MacroColumns) "Dicionário de macros não exibiu token, valor e disponibilidade."
    Add-Check "dicionário de macros com disponibilidade"

    $null = Invoke-CdpExpression "document.querySelector('[data-behavior-tab=simulator]').click(); true"
    Wait-CdpCondition "!document.getElementById('behaviorPanelSimulator').hidden && document.querySelector('[data-studio-form=simulator]')"
    $null = Invoke-CdpExpression @'
(() => {
  const form = document.querySelector('[data-studio-form="simulator"]');
  form.querySelector('[name="testTriggerId"]').value = "all";
  form.querySelector('[name="cpu"]').value = "99";
  form.querySelector('[name="ram"]').value = "97";
  form.querySelector('[name="disk"]').value = "96";
  form.requestSubmit();
  return true;
})()
'@
    Wait-CdpCondition "document.querySelectorAll('.behavior-result-card').length > 0"
    $Simulation = Invoke-CdpExpression @'
(() => ({
  results: document.querySelectorAll(".behavior-result-card").length,
  priorities: [...document.querySelectorAll(".behavior-result-card .behavior-chip")].some(item => /^P\d+/.test(item.textContent)),
  play: Boolean(document.querySelector('[data-action="play-simulation"]')),
  realCardsUnchanged: document.getElementById("machineValue").textContent !== "CPU 99% · RAM 97%",
}))()
'@
    Assert-Condition ($Simulation.results -gt 0) "Simulador não ativou gatilhos no cenário crítico."
    Assert-Condition ([bool] $Simulation.priorities -and [bool] $Simulation.play) "Resultado não exibiu prioridade/ação no painel."
    Assert-Condition ([bool] $Simulation.realCardsUnchanged) "Simulador alterou dados reais do dashboard."
    Add-Check "simulador isolado com reação executável"

    $null = Invoke-CdpExpression "document.querySelector('[data-action=play-simulation]').click(); true"
    Wait-CdpCondition "!document.getElementById('behaviorStudio').classList.contains('open')"
    $Playback = Invoke-CdpExpression @'
(() => ({
  status: document.getElementById("behaviorStudioStatus")?.textContent || "",
  activeSprite: [...document.querySelectorAll(".sprite-companion")].some(item => item.dataset.state !== "idle"),
}))()
'@
    Assert-Condition ($Playback.status.Contains("tempor") -and $Playback.status.Contains("executada")) "Executar no painel não confirmou a reação temporária: $($Playback.status)"
    Assert-Condition ([bool] $Playback.activeSprite) "Executar no painel não alterou temporariamente o estado de um sprite."
    Add-Check "Executar no painel reproduz e fecha o Studio"

    $null = Invoke-CdpExpression "document.getElementById('openBehaviorStudio').click(); true"
    Wait-CdpCondition "document.getElementById('behaviorStudio').classList.contains('open')"
    $null = Invoke-CdpExpression "document.querySelector('[data-behavior-tab=history]').click(); true"
    Wait-CdpCondition "!document.getElementById('behaviorPanelHistory').hidden && document.querySelector('.behavior-table')"
    $HistoryControls = Invoke-CdpExpression "Boolean(document.querySelector('[data-control=history-search]') && document.querySelector('[data-action=clear-history]'))"
    Assert-Condition ([bool] $HistoryControls) "Histórico não exibiu busca e limpeza."
    Add-Check "histórico com busca e limpeza"

    Set-Viewport 390 844
    Wait-UiSettled
    $Responsive = Invoke-CdpExpression @'
(() => {
  const rect = document.getElementById("behaviorStudio").getBoundingClientRect();
  const overflowing = [...document.querySelectorAll("#behaviorStudio *")]
    .map(element => ({ element: element.tagName + "." + element.className, rect: element.getBoundingClientRect() }))
    .filter(item => item.rect.right > innerWidth + 1 || item.rect.left < -1)
    .slice(0, 8)
    .map(item => ({ element: item.element, left: item.rect.left, right: item.rect.right, width: item.rect.width }));
  return {
    ok: rect.left >= -0.5 && rect.right <= innerWidth + 0.5 && getComputedStyle(document.body).overflowX === "hidden",
    viewport: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    studio: { left: rect.left, right: rect.right, width: rect.width },
    overflowing,
  };
})()
'@
    Assert-Condition ([bool] $Responsive.ok) "Studio provocou overflow horizontal no viewport móvel: $($Responsive | ConvertTo-Json -Depth 5 -Compress)"
    Add-Check "Studio responsivo no Edge"

    $null = Invoke-CdpExpression "document.getElementById('closeBehaviorStudio').click(); true"
    Wait-CdpCondition "!document.getElementById('behaviorStudio').classList.contains('open')"
    Wait-CdpCondition "document.querySelectorAll('.sprite-companion.talking').length === 0" 12000
}

function Remove-SafeTemporaryPath([string] $Path, [bool] $Recursive = $false) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return }
    $Resolved = [IO.Path]::GetFullPath($Path)
    $TempPrefix = $TempRoot.TrimEnd("\") + "\"
    $SafeName = (Split-Path -Leaf $Resolved) -like "$ArtifactPrefix*"
    if (-not $SafeName -or -not $Resolved.StartsWith($TempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Recusa ao remover artefato fora do TEMP esperado: $Resolved"
    }
    if ($Recursive) {
        Remove-Item -LiteralPath $Resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
    else {
        Remove-Item -LiteralPath $Resolved -Force -ErrorAction SilentlyContinue
    }
}

try {
    $Runtime = Resolve-SmokePython
    $ResolvedEdge = Resolve-SmokeEdge
    $ResolvedDashboardPort = Resolve-FreePort $DashboardPort
    do {
        $ResolvedDebugPort = Resolve-FreePort $DebugPort
    } while ($ResolvedDebugPort -eq $ResolvedDashboardPort)
    $DashboardUrl = "http://127.0.0.1:$ResolvedDashboardPort/"

    $DashboardArguments = @($Runtime.PrefixArgs) + @(
        "dashboard_server.py", "--host", "127.0.0.1", "--port", "$ResolvedDashboardPort",
        "--character-registry-root", $CharacterRegistryPath
    )
    $DashboardProcess = Start-Process `
        -FilePath $Runtime.Executable `
        -ArgumentList $DashboardArguments `
        -WorkingDirectory $ProjectRoot `
        -WindowStyle Hidden `
        -PassThru `
        -RedirectStandardOutput $DashboardOutPath `
        -RedirectStandardError $DashboardErrPath
    Wait-HttpOk $DashboardUrl $DashboardProcess
    $PackagePath = Join-Path $ProjectRoot "examples\characters\sentinel.codex-character.zip"
    $CharacterCatalog = Invoke-RestMethod -UseBasicParsing `
        -Uri "${DashboardUrl}api/studio/characters/v1" `
        -TimeoutSec 15
    $InstallResponse = Invoke-WebRequest -UseBasicParsing `
        -Method Post `
        -Uri "${DashboardUrl}api/studio/characters/v1/install" `
        -InFile $PackagePath `
        -Headers @{ "If-Match" = "`"$($CharacterCatalog.revision)`"" } `
        -ContentType "application/vnd.codex-character+zip" `
        -TimeoutSec 15
    Assert-Condition ($InstallResponse.StatusCode -eq 201) "Smoke não instalou o pacote oficial Sentinela."

    $EdgeArguments = @(
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--remote-allow-origins=*",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=$ResolvedDebugPort",
        "--user-data-dir=`"$ProfilePath`"",
        "--window-size=1440,900",
        "about:blank"
    )
    $EdgeProcess = Start-Process `
        -FilePath $ResolvedEdge `
        -ArgumentList $EdgeArguments `
        -WindowStyle Hidden `
        -PassThru `
        -RedirectStandardOutput $EdgeOutPath `
        -RedirectStandardError $EdgeErrPath

    $DebugReady = $false
    for ($Attempt = 0; $Attempt -lt 100 -and -not $DebugReady; $Attempt += 1) {
        if ($EdgeProcess.HasExited) { throw "Edge encerrou antes de disponibilizar o CDP." }
        try {
            $Version = Invoke-RestMethod -Uri "http://127.0.0.1:$ResolvedDebugPort/json/version" -TimeoutSec 1
            $DebugReady = [bool] $Version.webSocketDebuggerUrl
        }
        catch {
            Start-Sleep -Milliseconds 100
        }
    }
    if (-not $DebugReady) { throw "Endpoint CDP local não ficou disponível." }

    $EncodedDashboardUrl = [Uri]::EscapeDataString($DashboardUrl)
    $Target = Invoke-RestMethod `
        -Method Put `
        -Uri "http://127.0.0.1:$ResolvedDebugPort/json/new?$EncodedDashboardUrl" `
        -TimeoutSec 3
    if (-not $Target.webSocketDebuggerUrl) { throw "CDP não retornou a URL WebSocket da página." }

    Connect-Cdp $Target.webSocketDebuggerUrl
    $null = Invoke-CdpCommand "Page.enable"
    $null = Invoke-CdpCommand "Runtime.enable"
    $null = Invoke-CdpCommand "Page.bringToFront"
    Wait-CdpCondition "document.readyState === 'complete' && document.querySelectorAll('.sprite-companion').length > 0" 15000
    Wait-CdpCondition "document.getElementById('spriteWorld').dataset.configStatus === 'valid'" 5000
    $null = Invoke-CdpExpression @'
(() => {
  window.__dashboardSmokeErrors = [];
  window.addEventListener("error", event => window.__dashboardSmokeErrors.push(String(event.error?.stack || event.message)));
  window.addEventListener("unhandledrejection", event => window.__dashboardSmokeErrors.push(String(event.reason?.stack || event.reason)));
  return true;
})()
'@
    $null = Invoke-CdpCommand "Emulation.setEmulatedMedia" @{
        features = @(@{ name = "prefers-reduced-motion"; value = "no-preference" })
    }
    Wait-CdpCondition "document.getElementById('spriteWorld').dataset.reducedMotion === 'false'"

    Test-BehaviorStudio
    Test-GeometryMatrix
    Test-ReducedMotion
    Test-Drag
    Test-Toggles

    $RuntimeErrors = @(Invoke-CdpExpression "window.__dashboardSmokeErrors || []")
    Assert-Condition ($RuntimeErrors.Count -eq 0) "Erros JavaScript durante o smoke: $($RuntimeErrors -join '; ')."

    Write-Host "Smoke E2E do dashboard: $($Checks.Count) verificações passaram." -ForegroundColor Green
    $Checks | ForEach-Object { Write-Host "  [OK] $_" }
}
finally {
    if ($CdpSocket -and $CdpSocket.State -eq [Net.WebSockets.WebSocketState]::Open) {
        try { $null = Invoke-CdpCommand "Browser.close" } catch {}
    }
    if ($CdpSocket) { $CdpSocket.Dispose() }
    Start-Sleep -Milliseconds 250
    if ($EdgeProcess -and -not $EdgeProcess.HasExited) {
        Stop-Process -Id $EdgeProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($DashboardProcess -and -not $DashboardProcess.HasExited) {
        Stop-Process -Id $DashboardProcess.Id -Force -ErrorAction SilentlyContinue
    }

    foreach ($Attempt in 1..20) {
        Remove-SafeTemporaryPath $ProfilePath $true
        if (-not (Test-Path -LiteralPath $ProfilePath)) { break }
        Start-Sleep -Milliseconds 100
    }
    @($DashboardOutPath, $DashboardErrPath, $EdgeOutPath, $EdgeErrPath) | ForEach-Object {
        Remove-SafeTemporaryPath $_ $false
    }
    Remove-SafeTemporaryPath $CharacterRegistryPath $true
}
