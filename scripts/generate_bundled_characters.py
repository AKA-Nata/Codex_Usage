from __future__ import annotations

import argparse, json, shutil, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from build_character_package import build
from codex_usage.pixel_art import CharacterDefinition, render_frame, render_sheet

OUTPUT = ROOT / "web" / "assets" / "bundled-character-packages"
STATES = ("idle", "walk", "inspect", "point", "talk", "happy", "worried", "critical", "hot", "cold", "sleep", "wake", "confused", "celebrate", "dragging")
NOTICE = "Original simplified fan-art for local dashboard use. Not official artwork. Character names and related rights belong to their respective holders. This package grants no trademark or character rights.\n"
LICENSE = "Package metadata and original pixel-art code are provided with the project; named fictional characters are not licensed by this notice.\n"

def d(identifier, name, personality, colors, *traits):
    franchise = "naruto" if identifier == "itachi" else "pokemon"
    return CharacterDefinition(identifier, name, personality, ("bundled", "fan-art", franchise, personality), colors, traits)

DEFINITIONS = (
 d("itachi","Itachi Uchiha","silent",((45,45,55,255),(180,40,40,255),(18,18,25,255)),"hair","headband","cloak"),
 d("pikachu","Pikachu","energetic",((245,205,45,255),(255,85,65,255),(80,55,25,255)),"ears_long","tail_lightning"), d("raichu","Raichu","cheerful",((225,135,55,255),(255,220,105,255),(92,52,30,255)),"ears_round","tail_long"),
 d("charmander","Charmander","brave",((242,130,65,255),(255,90,35,255),(95,50,35,255)),"tail_long","flame"), d("charizard","Charizard","bold",((220,105,45,255),(75,130,180,255),(80,42,25,255)),"wings","flame","antennae"),
 d("squirtle","Squirtle","calm",((95,175,215,255),(210,185,100,255),(50,75,105,255)),"shell"), d("blastoise","Blastoise","steady",((65,135,190,255),(190,155,90,255),(40,60,90,255)),"shell","cannons"),
 d("bulbasaur","Bulbasaur","gentle",((95,180,145,255),(75,145,85,255),(45,85,75,255)),"bulb"), d("venusaur","Venusaur","grounded",((75,145,120,255),(225,90,130,255),(40,80,65,255)),"flower"),
 d("eevee","Eevee","curious",((165,110,65,255),(245,225,190,255),(75,45,30,255)),"ears_long","collar"), d("vaporeon","Vaporeon","fluid",((80,145,220,255),(225,235,255,255),(45,80,140,255)),"fins","collar"),
 d("jolteon","Jolteon","electric",((240,205,60,255),(255,245,175,255),(120,95,25,255)),"spikes","collar"), d("flareon","Flareon","warm",((225,115,60,255),(255,230,155,255),(115,55,30,255)),"ears_long","collar"),
 d("umbreon","Umbreon","nightwatch",((50,55,70,255),(245,210,55,255),(25,25,35,255)),"ears_long","rings"), d("espeon","Espeon","insightful",((205,115,180,255),(185,70,145,255),(90,45,80,255)),"ears_long","gem"),
 d("snorlax","Snorlax","sleepy",((80,130,135,255),(225,220,185,255),(35,70,75,255)),"wide"), d("gengar","Gengar","humorous",((105,65,160,255),(235,80,130,255),(55,30,85,255)),"spiny"),
 d("psyduck","Psyduck","confused",((245,205,65,255),(245,145,55,255),(100,80,25,255)),"beak"), d("meowth","Meowth","mischievous",((230,190,125,255),(245,205,55,255),(105,70,40,255)),"coin","ears_round"),
 d("mew","Mew","playful",((225,150,210,255),(245,205,240,255),(120,65,115,255)),"tail_long"), d("mewtwo","Mewtwo","analytical",((210,205,225,255),(165,85,185,255),(85,70,115,255)),"tail_long","wide"),
 d("lucario","Lucario","technical",((55,110,190,255),(220,190,80,255),(30,55,100,255)),"ears_long","mask"), d("dragonite","Dragonite","helpful",((225,140,65,255),(105,180,120,255),(100,55,30,255)),"wings","antennae"),
 d("piplup","Piplup","determined",((60,110,190,255),(245,210,75,255),(30,55,100,255)),"penguin"), d("rowlet","Rowlet","observant",((145,105,65,255),(105,175,95,255),(65,50,35,255)),"owl"), d("cyndaquil","Cyndaquil","shy",((75,115,165,255),(245,100,40,255),(40,60,105,255)),"fire_back"),
)

def phrase(definition):
    templates = {"sleepy":"O ritmo está tranquilo; vou guardar energia.","confused":"Hmm, esse sinal merece uma segunda leitura.","humorous":"Um alerta apareceu. Prometo não escondê-lo nas sombras.","analytical":"Dados primeiro: a próxima decisão fica mais clara.","technical":"Telemetria observada; mantenho o sistema sob análise.","energetic":"Energia boa! Vamos aproveitar a próxima janela.","silent":"Observar com calma também é uma forma de agir."}
    return templates.get(definition.personality, f"{definition.name} acompanha esta janela com atenção.")

def manifest(definition):
    assets = {state: {"file": f"assets/{state}.png", "mediaType": "image/png"} for state in STATES}
    specs = {state: {"asset": state, "frame": {"width":256,"height":256,"count":4,"columns":4},"fps":6,"loop":state not in {"wake","celebrate"},"fallback":"idle"} for state in STATES}
    return {"schemaVersion":"1.0.0","id":definition.id,"name":definition.name,"author":{"name":"Codex Usage Monitor","url":"local bundled fan-art"},"version":"1.0.0","compatibility":{"dashboard":{"min":"5.0.0","maxExclusive":"6.0.0"},"behaviorSchema":{"min":"2.0.0","maxExclusive":"4.0.0"}},"visualIdentity":{"baseline":0.9,"anchor":{"x":0.5,"y":0.88},"orientation":"right"},"personality":{"id":definition.personality},"tags":list(definition.tags),"capabilities":["speech","movement","reactions"],"assets":assets,"states":specs,"fallback":{"state":"idle"},"license":{"name":"Project package metadata notice","file":"LICENSE.txt"},"checksums":{"algorithm":"sha256","files":{}}}

def build_all(output=OUTPUT):
    output.mkdir(parents=True, exist_ok=True)
    for definition in DEFINITIONS:
        with tempfile.TemporaryDirectory(prefix=f"bundled-{definition.id}-") as temp:
            source = Path(temp); (source / "assets").mkdir()
            for state in STATES: (source / "assets" / f"{state}.png").write_bytes(render_sheet(definition, state))
            (source / "preview.png").write_bytes(render_frame(definition, "idle", 0))
            (source / "manifest.json").write_text(json.dumps(manifest(definition), ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
            (source / "behaviors.json").write_text(json.dumps({"schemaVersion":"1.0.0","triggers":[{"id":"usage_watch","name":"Acompanhamento de uso","enabled":True,"when":{"metric":"codex_5h_percentual","operator":"<=","value":30},"targetCard":"codex_5h","spriteState":"worried","phraseRefs":["ambient"],"priority":40,"cooldownSeconds":60,"durationSeconds":5,"persistent":False,"repeatWhileActive":True,"preventRepeat":True}]}, ensure_ascii=False, indent=2)+"\n",encoding="utf-8",newline="\n")
            (source / "phrases.json").write_text(json.dumps({"schemaVersion":"1.0.0","personality":definition.personality,"groups":[{"id":"ambient","texts":[phrase(definition)]}]}, ensure_ascii=False, indent=2)+"\n",encoding="utf-8",newline="\n")
            (source / "LICENSE.txt").write_text(LICENSE,encoding="utf-8",newline="\n"); (source / "NOTICE.txt").write_text(NOTICE,encoding="utf-8",newline="\n")
            build(source, output / f"{definition.id}.codex-character.zip")

if __name__ == "__main__":
    parser=argparse.ArgumentParser(description="Generate deterministic bundled fan-art packages."); parser.add_argument("--output",type=Path,default=OUTPUT); args=parser.parse_args(); build_all(args.output); print(f"Generated {len(DEFINITIONS)} bundled packages in {args.output}")
