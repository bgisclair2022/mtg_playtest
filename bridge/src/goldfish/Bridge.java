package goldfish;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.common.eventbus.Subscribe;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import forge.GuiDesktop;
import forge.LobbyPlayer;
import forge.card.MagicColor;
import forge.deck.CardPool;
import forge.deck.Deck;
import forge.deck.io.DeckSerializer;
import forge.game.GameEntityView;
import forge.game.GameLogEntry;
import forge.game.GameLogEntryType;
import forge.game.GameType;
import forge.game.GameView;
import forge.game.card.Card;
import forge.game.card.CardView;
import forge.game.card.CounterType;
import forge.game.combat.CombatView;
import forge.game.event.GameEvent;
import forge.game.event.GameEventAttackersDeclared;
import forge.game.event.GameEventBlockersDeclared;
import forge.game.event.GameEventLandPlayed;
import forge.game.event.GameEventSpellAbilityCast;
import forge.game.event.GameEventSpellResolved;
import forge.game.event.GameEventTurnBegan;
import forge.game.phase.PhaseType;
import forge.game.player.DelayedReveal;
import forge.game.player.IHasIcon;
import forge.game.player.Player;
import forge.game.player.PlayerView;
import forge.game.player.RegisteredPlayer;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.SpellAbilityView;
import forge.game.spellability.StackItemView;
import forge.game.zone.ZoneType;
import forge.gamemodes.match.AbstractGuiGame;
import forge.gamemodes.match.HostedMatch;
import forge.gui.GuiBase;
import forge.interfaces.IGameController;
import forge.item.PaperCard;
import forge.localinstance.properties.ForgePreferences;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.localinstance.skin.FSkinProp;
import forge.model.FModel;
import forge.player.GamePlayerUtil;
import forge.player.LobbyPlayerHuman;
import forge.player.PlayerControllerHuman;
import forge.trackable.TrackableCollection;
import forge.util.FSerializableFunction;
import forge.util.ITriggerEvent;

import javax.swing.SwingUtilities;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Runs a 1v1 Commander match on Forge's engine (you vs Forge AI) and exposes it to the
 * MTG Goldfish board over a local HTTP API:
 *
 *   GET  /state?v=N   game snapshot; long-polls until the version is newer than N
 *   POST /act         {"type": "card"|"player"|"ok"|"cancel"|"alpha"|"concede"|"undo"|"autopass", ...}
 *   POST /answer      {"id": askId, "value": ...} answers the pending question (choices, confirms, numbers)
 *
 * Usage: java -cp forge.jar;classes goldfish.Bridge <port> <your.dck> <bot.dck>   (cwd = Forge folder)
 */
public final class Bridge {

    public static void main(String[] args) throws Exception {
        final int port = Integer.parseInt(args[0]);
        System.setProperty("java.util.Arrays.useLegacyMergeSort", "true"); // same workaround Forge's own launcher uses

        GuiBase.setInterface(new GuiDesktop());
        FModel.initialize(null, null);
        final ForgePreferences prefs = FModel.getPreferences();
        if (prefs.getPref(FPref.PLAYER_NAME).isBlank()) {
            prefs.setPref(FPref.PLAYER_NAME, "You"); // otherwise Forge pops a name dialog
        }
        prefs.setPref(FPref.YIELD_AUTO_PASS_NO_ACTIONS, "false"); // the bridge decides when to auto-pass (maybeAutoPass)
        prefs.setPref(FPref.YIELD_SKIP_PHASE_DELAY, "true");
        prefs.setPref(FPref.YIELD_SKIP_RESOLVE_DELAY, "true");
        // Scry via "pick cards for the bottom, then order the top" (the card-display variant needs a
        // drag-and-drop list this board doesn't have, and would silently leave the library as-is).
        prefs.setPref(FPref.UI_SELECT_FROM_CARD_DISPLAYS, "false");
        // Makes Forge publish which mana sources can pay the current cost (and which "Auto" would tap).
        prefs.setPref(FPref.UI_SHOW_ACTIONABLE_HIGHLIGHTS, "true");

        final Deck yours = DeckSerializer.fromFile(new File(args[1]));
        final Deck bots = DeckSerializer.fromFile(new File(args[2]));
        if (yours == null || bots == null) {
            throw new IllegalArgumentException("Could not read deck files");
        }

        final WebGui gui = new WebGui();
        serve(port, gui);
        // Exit when the app that launched us goes away (it holds our stdin open).
        final Thread watchdog = new Thread(() -> {
            try {
                while (System.in.read() != -1) { /* keep reading */ }
            } catch (IOException ignored) { }
            System.exit(0);
        }, "goldfish-parent-watch");
        watchdog.setDaemon(true);
        watchdog.start();

        final RegisteredPlayer human = RegisteredPlayer.forCommander(yours);
        human.setPlayer(new LobbyPlayerHuman(args.length > 3 && !args[3].isBlank() ? args[3] : "You"));
        final RegisteredPlayer ai = RegisteredPlayer.forCommander(bots);
        final LobbyPlayer stock = GamePlayerUtil.createAiPlayer("Bot", 1);
        ai.setPlayer(System.getenv("GOLDFISH_LLM") == null ? stock // "advanced bot" off: plain Forge AI
                : new Strategist("Bot", ((forge.ai.LobbyPlayerAi) stock).getAiProfile(), text -> gui.pace(text, null, 1.0)));

        final HostedMatch match = new HostedMatch();
        // Subscribe the pacer as soon as the game exists, before its thread starts playing.
        match.setStartGameHook(() -> match.getGame().subscribeToEvents(new Pacer(gui)));
        SwingUtilities.invokeAndWait(() -> match.startMatch(GameType.Commander, null, List.of(human, ai), human, gui));
        System.out.println("READY " + port);
    }

    // ---- HTTP ----------------------------------------------------------------

    private static void serve(int port, WebGui gui) throws IOException {
        final HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.setExecutor(Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "goldfish-http");
            t.setDaemon(true);
            return t;
        }));
        server.createContext("/state", ex -> {
            long since = -1;
            final String q = ex.getRequestURI().getQuery();
            if (q != null && q.startsWith("v=")) {
                since = Long.parseLong(q.substring(2));
            }
            gui.awaitChange(since, 20_000);
            reply(ex, gui.snapshot());
        });
        server.createContext("/act", ex -> {
            final JsonObject a = body(ex);
            if (a != null) {
                SwingUtilities.invokeLater(() -> gui.act(a));
            }
            reply(ex, new JsonObject());
        });
        server.createContext("/answer", ex -> {
            final JsonObject a = body(ex);
            if (a != null) {
                gui.answer(a.get("id").getAsInt(), a.get("value"));
            }
            reply(ex, new JsonObject());
        });
        server.start();
    }

    private static JsonObject body(HttpExchange ex) throws IOException {
        if (!"POST".equals(ex.getRequestMethod())) {
            return null;
        }
        return JsonParser.parseString(new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject();
    }

    private static void reply(HttpExchange ex, JsonElement json) throws IOException {
        final byte[] out = json.toString().getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json");
        ex.getResponseHeaders().add("Access-Control-Allow-Origin", "*");
        ex.getResponseHeaders().add("Access-Control-Allow-Headers", "*");
        ex.sendResponseHeaders(200, out.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(out);
        }
    }

    // ---- pacing ----------------------------------------------------------------

    /**
     * Forge's AI acts as fast as the engine runs. Game events are delivered on the game thread,
     * so pausing here after each visible bot action gives you time to see it (Forge's own
     * AI-vs-AI playback slows games the same way).
     */
    public static final class Pacer {
        private final WebGui gui;

        Pacer(WebGui gui) {
            this.gui = gui;
        }

        @Subscribe
        public void receive(GameEvent ev) {
            if (ev instanceof GameEventSpellAbilityCast e && e.si() != null && e.si().isTrigger()) {
                return; // triggers are announced by the board's "Trigger!" pop-up and paced in maybeAutoPass
            } else if (ev instanceof GameEventSpellAbilityCast e && e.si() != null && isBot(e.si().getActivatingPlayer())) {
                final CardView host = e.sa().getHostCard();
                final String targets = e.targetDescription() == null || e.targetDescription().isBlank() ? "" : " → " + e.targetDescription();
                // Something already on the stack means the AI chose to respond to it: say so.
                final StackItemView under = beneath(e.si());
                if (under != null) {
                    final String whose = under.getActivatingPlayer() != null && !isBot(under.getActivatingPlayer()) ? "your" : "its own";
                    gui.pace("Bot responds with " + name(host) + targets + " (in response to " + whose + " " + name(under.getSourceCard()) + ")", host, 1.2);
                } else {
                    gui.pace("Bot " + (e.si().isAbility() ? "activates" : "casts") + " " + name(host) + targets, host, 1.0);
                }
            } else if (ev instanceof GameEventLandPlayed e && isBot(e.player())) {
                gui.pace("Bot plays " + name(e.land()), e.land(), 0.5);
            } else if (ev instanceof GameEventAttackersDeclared e && isBot(e.player()) && !e.attackersMap().isEmpty()) {
                final int n = e.attackersMap().size();
                gui.pace("Bot attacks with " + n + (n == 1 ? " creature" : " creatures"), e.attackersMap().values().iterator().next(), 1.3);
            } else if (ev instanceof GameEventBlockersDeclared e && isBot(e.defendingPlayer()) && !e.blockers().isEmpty()) {
                gui.pace("Bot declares blockers", null, 1.0);
            } else if (ev instanceof GameEventSpellResolved e && e.spell() != null && e.spell().getHostCard() != null
                    && isBot(e.spell().getHostCard().getController())) {
                gui.pace(name(e.spell().getHostCard()) + (e.hasFizzled() ? " fizzles" : " resolves"), e.spell().getHostCard(), 0.6);
            } else if (ev instanceof GameEventTurnBegan e) {
                gui.pace("Round " + (e.turnNumber() + 1) / 2 + " · " + (isBot(e.turnOwner()) ? "Bot's turn" : "Your turn"), null, isBot(e.turnOwner()) ? 0.7 : 0.3);
            }
        }

        /** The stack item just below {@code si}, i.e. what it was cast in response to (null if the stack was empty). */
        private StackItemView beneath(StackItemView si) {
            final GameView gv = gui.getGameView();
            if (gv == null || gv.getStack() == null) {
                return null;
            }
            for (StackItemView other : gv.getStack()) {
                if (other.getId() != si.getId()) {
                    return other;
                }
            }
            return null;
        }

        private static boolean isBot(PlayerView p) {
            return p != null && p.isAI();
        }

        private static String name(CardView c) {
            return c == null ? "something" : c.getCurrentState().getName();
        }
    }

    // ---- the GUI Forge talks to ------------------------------------------------

    static final class WebGui extends AbstractGuiGame {
        private final Object lock = new Object();
        private long version = 0;
        private String prompt = "";
        private JsonObject promptCard;
        private String okLabel = "OK", cancelLabel = "Cancel";
        private boolean okOn, cancelOn;
        private Ask pending;
        private int askSeq = 0, noticeSeq = 0;
        private final Deque<JsonObject> notices = new ArrayDeque<>();
        private volatile boolean autoPass = true, autoPay = false;
        private volatile int paceMs = 4000; // base pause after a bot action; the board's speed setting changes it
        private int actionSeq = 0;
        private JsonObject lastAction;
        private final Set<Integer> seenTriggers = ConcurrentHashMap.newKeySet();
        private volatile boolean holding;
        private volatile int untappedSources = -1;

        private boolean gv0HasStack() {
            final GameView gv = getGameView();
            return gv != null && gv.peekStack() != null;
        }
        private final Map<Integer, CardView> cards = new ConcurrentHashMap<>();
        private final Map<Integer, PlayerView> players = new ConcurrentHashMap<>();
        private volatile Set<Integer> playableNow = new HashSet<>();
        private final ExecutorService worker = Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "goldfish-playable");
            t.setDaemon(true);
            return t;
        });
        private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "goldfish-autopass");
            t.setDaemon(true);
            return t;
        });

        private static final class Ask {
            final int id;
            final JsonObject question;
            final CompletableFuture<JsonElement> answer = new CompletableFuture<>();

            Ask(int id, JsonObject question) {
                this.id = id;
                this.question = question;
            }
        }

        // -- change tracking / long-poll

        private void bump() {
            synchronized (lock) {
                version++;
                lock.notifyAll();
            }
            timer.schedule(this::maybeAutoPass, 250, TimeUnit.MILLISECONDS);
        }

        void awaitChange(long since, long timeoutMs) {
            final long end = System.currentTimeMillis() + timeoutMs;
            synchronized (lock) {
                while (version <= since) {
                    final long left = end - System.currentTimeMillis();
                    if (left <= 0) {
                        return;
                    }
                    try {
                        lock.wait(left);
                    } catch (InterruptedException e) {
                        return;
                    }
                }
            }
        }

        /** Take the clicks you'd always make anyway: auto-pay mana costs, and pass priority on the bot's turn. */
        private void maybeAutoPass() {
            final GameView gv = getGameView();
            if (pending != null || gv == null || gv.isGameOver()) {
                return;
            }
            final String input = inputName();
            if (autoPay && input != null && input.startsWith("InputPayMana") && okOn) {
                SwingUtilities.invokeLater(() -> {
                    final String now = inputName();
                    if (now != null && now.startsWith("InputPayMana") && okOn) {
                        getGameController().selectButtonOk(); // Forge's "Auto" payment
                    }
                });
                return;
            }
            if (!"InputPassPriority".equals(input)) {
                return;
            }
            final StackItemView top = gv.peekStack();
            if (top == null) {
                return; // empty stack: Forge only asks at stops we chose (your main phases, response windows)
            }
            // Something is on the stack. Safe to inspect the game: its thread is parked on this input.
            final boolean canRespond = !actions(gv, true).isEmpty();
            holding = canRespond;
            if (top.isTrigger()) {
                // Triggers (yours or the bot's): the board pops up "Trigger!". Hold if you can respond;
                // otherwise give you a moment to read it, then let it resolve.
                final boolean first = seenTriggers.add(top.getId());
                if (!canRespond) {
                    passLater(top.getId(), first ? Math.max(900, paceMs) : 0);
                }
                return;
            }
            final boolean botsSpell = top.getActivatingPlayer() == null || !isLocalPlayer(top.getActivatingPlayer());
            if (botsSpell && (canRespond || !autoPass)) {
                return; // hold: you can answer the bot's spell (or auto-pass is off)
            }
            passLater(top.getId(), 0); // your own spell, or nothing you could do about theirs
        }

        /** Pass priority after a delay, if we're still waiting on the same stack item. */
        private void passLater(int stackItemId, long delayMs) {
            timer.schedule(() -> SwingUtilities.invokeLater(() -> {
                final GameView g = getGameView();
                final StackItemView t = g == null ? null : g.peekStack();
                if (pending == null && t != null && t.getId() == stackItemId && "InputPassPriority".equals(inputName())) {
                    getGameController().selectButtonOk();
                }
            }), delayMs, TimeUnit.MILLISECONDS);
        }

        private String inputName() {
            final IGameController c = getGameController();
            if (c instanceof PlayerControllerHuman pch && pch.getInputQueue().getInput() != null) {
                return pch.getInputQueue().getInput().getClass().getSimpleName();
            }
            return null;
        }

        // -- actions from the board

        void act(JsonObject a) {
            final IGameController c = getGameController();
            if (c == null) {
                return;
            }
            switch (a.get("type").getAsString()) {
                case "ok" -> c.selectButtonOk();
                case "cancel" -> c.selectButtonCancel();
                case "card" -> {
                    final CardView cv = cards.get(a.get("id").getAsInt());
                    if (cv != null && !c.selectCard(cv, null, null)) {
                        notice("That can't be done right now.");
                    }
                }
                case "player" -> {
                    final PlayerView pv = players.get(a.get("id").getAsInt());
                    if (pv != null) {
                        c.selectPlayer(pv, null);
                    }
                }
                case "alpha" -> c.alphaStrike();
                case "undo" -> c.undoLastAction();
                case "concede" -> c.concede();
                case "autopass" -> {
                    autoPass = a.get("value").getAsBoolean();
                    bump();
                }
                case "speed" -> {
                    paceMs = Math.max(0, Math.min(10000, a.get("value").getAsInt()));
                    bump();
                }
                case "mana" -> {
                    final String color = a.get("color").getAsString();
                    c.useMana(color.equals("C") ? MagicColor.COLORLESS : MagicColor.fromName(color.toLowerCase().charAt(0)));
                }
                case "autopay" -> {
                    autoPay = a.get("value").getAsBoolean();
                    bump();
                }
                default -> { }
            }
        }

        /** Publish what the bot just did, then hold the game thread so you can take it in. */
        void pace(String text, CardView card, double weight) {
            synchronized (lock) {
                final JsonObject a = new JsonObject();
                a.addProperty("id", ++actionSeq);
                a.addProperty("text", text);
                a.addProperty("ms", (int) (paceMs * weight));
                if (card != null) {
                    a.add("card", card(card));
                }
                lastAction = a;
            }
            bump();
            if (paceMs > 0) {
                try {
                    Thread.sleep((long) (paceMs * weight));
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
            }
        }

        void answer(int id, JsonElement value) {
            final Ask a = pending;
            if (a != null && a.id == id) {
                a.answer.complete(value);
            }
        }

        /** Block the game thread until the board answers. */
        private JsonElement ask(String kind, String message, JsonObject extra) {
            final Ask a;
            synchronized (lock) {
                extra.addProperty("kind", kind);
                extra.addProperty("message", message == null ? "" : message);
                a = new Ask(++askSeq, extra);
                extra.addProperty("id", a.id);
                pending = a;
            }
            bump();
            try {
                return a.answer.get();
            } catch (Exception e) {
                return JsonNull.INSTANCE;
            } finally {
                synchronized (lock) {
                    if (pending == a) {
                        pending = null;
                    }
                }
                bump();
            }
        }

        private void notice(String text) {
            synchronized (lock) {
                final JsonObject n = new JsonObject();
                n.addProperty("id", ++noticeSeq);
                n.addProperty("text", text);
                notices.addLast(n);
                while (notices.size() > 8) {
                    notices.removeFirst();
                }
            }
            bump();
        }

        // -- snapshot

        JsonObject snapshot() {
            for (int attempt = 0; ; attempt++) {
                try {
                    return buildSnapshot();
                } catch (RuntimeException e) { // views are mutated by the game thread; retry a torn read
                    if (attempt >= 4) {
                        final JsonObject o = new JsonObject();
                        o.addProperty("version", version);
                        o.addProperty("error", String.valueOf(e));
                        return o;
                    }
                }
            }
        }

        private JsonObject buildSnapshot() {
            final JsonObject o = new JsonObject();
            final JsonObject p = new JsonObject();
            synchronized (lock) {
                o.addProperty("version", version);
                p.addProperty("message", prompt);
                p.add("card", promptCard == null ? JsonNull.INSTANCE : promptCard);
                p.addProperty("ok", okLabel);
                p.addProperty("cancel", cancelLabel);
                p.addProperty("okOn", okOn);
                p.addProperty("cancelOn", cancelOn);
                o.add("ask", pending == null ? JsonNull.INSTANCE : pending.question);
                o.add("lastAction", lastAction == null ? JsonNull.INSTANCE : lastAction);
                o.addProperty("speed", paceMs);
                final JsonArray ns = new JsonArray();
                notices.forEach(ns::add);
                o.add("notices", ns);
            }
            p.addProperty("input", inputName());
            o.add("prompt", p);
            o.addProperty("autoPass", autoPass);
            o.addProperty("autoPay", autoPay);
            o.addProperty("holding", holding && gv0HasStack());

            final GameView gv = getGameView();
            if (gv == null) {
                return o;
            }
            o.addProperty("turn", gv.getTurn());
            o.addProperty("round", (gv.getTurn() + 1) / 2);
            o.addProperty("phase", gv.getPhase() == null ? "" : gv.getPhase().nameForUi);
            o.addProperty("phaseKey", gv.getPhase() == null ? "" : gv.getPhase().name());
            o.addProperty("activePlayer", gv.getPlayerTurn() == null ? -1 : gv.getPlayerTurn().getId());
            o.addProperty("mulligan", gv.isMulligan());
            o.addProperty("gameOver", gv.isGameOver());
            o.addProperty("winner", gv.isGameOver() ? gv.getWinningPlayerName() : null);
            o.addProperty("me", getCurrentPlayer() == null ? -1 : getCurrentPlayer().getId());

            try { // reads live game state from another thread; never let it hold up the board
                playableNow = worker.submit(() -> playableIds(gv)).get(1500, TimeUnit.MILLISECONDS);
            } catch (Exception e) {
                // keep the previous highlight set
            }
            final JsonArray ps = new JsonArray();
            for (PlayerView pv : gv.getPlayers()) {
                ps.add(player(pv, gv));
            }
            o.add("players", ps);

            final JsonArray stack = new JsonArray();
            if (gv.getStack() != null) {
                for (StackItemView si : gv.getStack()) {
                    final JsonObject s = new JsonObject();
                    s.addProperty("id", si.getId());
                    s.addProperty("text", si.getText());
                    s.addProperty("trigger", si.isTrigger());
                    s.addProperty("top", gv.peekStack() != null && gv.peekStack().getId() == si.getId());
                    final JsonArray targets = new JsonArray();
                    for (StackItemView part = si; part != null; part = part.getSubInstance()) {
                        if (part.getTargetCards() != null) {
                            for (CardView t : part.getTargetCards()) {
                                final JsonObject tj = new JsonObject();
                                tj.addProperty("card", t.getId());
                                tj.addProperty("name", t.getCurrentState().getName());
                                targets.add(tj);
                            }
                        }
                        if (part.getTargetPlayers() != null) {
                            for (PlayerView t : part.getTargetPlayers()) {
                                final JsonObject tj = new JsonObject();
                                tj.addProperty("player", t.getId());
                                tj.addProperty("name", t.getName());
                                targets.add(tj);
                            }
                        }
                    }
                    s.add("targets", targets);
                    s.addProperty("mine", si.getActivatingPlayer() != null && isLocalPlayer(si.getActivatingPlayer()));
                    if (si.getSourceCard() != null) {
                        s.add("card", card(si.getSourceCard()));
                    }
                    s.addProperty("player", si.getActivatingPlayer() == null ? "" : si.getActivatingPlayer().getName());
                    stack.add(s);
                }
            }
            o.add("stack", stack);

            final JsonArray combat = new JsonArray();
            final CombatView cv = gv.getCombat();
            if (cv != null) {
                for (CardView attacker : cv.getAttackers()) {
                    final JsonObject a = new JsonObject();
                    a.addProperty("attacker", attacker.getId());
                    final GameEntityView d = cv.getDefender(attacker);
                    a.addProperty("defender", d == null ? "" : d.getName());
                    final JsonArray bs = new JsonArray();
                    final Collection<CardView> blockers = cv.getBlockers(attacker);
                    if (blockers != null) {
                        blockers.forEach(b -> bs.add(b.getId()));
                    }
                    a.add("blockers", bs);
                    combat.add(a);
                }
            }
            o.add("combat", combat);

            final JsonArray log = new JsonArray();
            if (gv.getGameLog() != null) {
                // newest last; skip per-step phase lines and mana noise
                final List<GameLogEntry> entries = new ArrayList<>(gv.getGameLog().getAllEntries());
                entries.removeIf(e -> e.type() == GameLogEntryType.PHASE || e.type() == GameLogEntryType.MANA);
                for (GameLogEntry e : entries.subList(Math.max(0, entries.size() - 80), entries.size())) {
                    log.add(e.message());
                }
            }
            o.add("log", log);
            return o;
        }

        /** Cards you could play or activate right now (ignoring mana abilities), for highlighting. */
        private Set<Integer> playableIds(GameView gv) {
            if (!"InputPassPriority".equals(inputName())) {
                if (getCurrentPlayer() != null) { // keep the mana tracker current while paying costs
                    int sources = 0;
                    for (Card c : gv.getGame().getPlayer(getCurrentPlayer()).getCardsIn(ZoneType.Battlefield)) {
                        if (!c.isTapped() && !c.getManaAbilities().isEmpty() && !(c.isCreature() && c.isSick())) {
                            sources++;
                        }
                    }
                    untappedSources = sources;
                }
                return new HashSet<>();
            }
            return actions(gv, false);
        }

        /**
         * Cards with something you could do right now: legal timing, affordable (roughly), and at least
         * one legal target if it targets. With {@code respondOnly}, lands are left out, so a non-empty
         * result means "you have a real response" and the game should wait for you.
         */
        private Set<Integer> actions(GameView gv, boolean respondOnly) {
            final Set<Integer> out = new HashSet<>();
            if (getCurrentPlayer() == null) {
                return out;
            }
            final Player me = gv.getGame().getPlayer(getCurrentPlayer());
            int mana = me.getManaPool().totalMana();
            int sources = 0;
            for (Card c : me.getCardsIn(ZoneType.Battlefield)) { // untapped things that tap for mana right now
                if (!c.isTapped() && !c.getManaAbilities().isEmpty() && !(c.isCreature() && c.isSick())) {
                    mana++;
                    sources++;
                }
            }
            untappedSources = sources;
            for (ZoneType z : new ZoneType[]{ZoneType.Hand, ZoneType.Command, ZoneType.Battlefield, ZoneType.Graveyard, ZoneType.Exile}) {
                for (Card c : me.getCardsIn(z)) {
                    for (SpellAbility sa : c.getAllPossibleAbilities(me, true)) {
                        if (sa.isManaAbility() || (sa.isLandAbility() && respondOnly)) {
                            continue;
                        }
                        if (sa.isLandAbility() || (canUseNow(sa, me) && affordable(sa, mana) && hasTargets(sa))) {
                            out.add(c.getId());
                            break;
                        }
                    }
                }
            }
            return out;
        }

        /**
         * Rough, side-effect-free affordability: mana value vs. mana you could produce (colors ignored).
         * Forge's exact check (ComputerUtilMana.canPayManaCost) can open prompts, e.g. for convoke, so it
         * must never run from here; Forge still validates the real payment when you click.
         */
        private static boolean canUseNow(SpellAbility sa, Player me) {
            try {
                return sa.canCastTiming(me);
            } catch (RuntimeException e) {
                return true;
            }
        }

        /** A targeted spell/ability only counts if something legal to target exists (e.g. Doom Blade needs a creature). */
        private static boolean hasTargets(SpellAbility sa) {
            try {
                return !sa.usesTargeting() || sa.getTargetRestrictions().hasCandidates(sa);
            } catch (RuntimeException e) {
                return true; // when unsure, don't hide it
            }
        }

        private static boolean affordable(SpellAbility sa, int availableMana) {
            if (sa.getPayCosts() == null || !sa.getPayCosts().hasManaCost()) {
                return true;
            }
            return sa.getPayCosts().getTotalMana().getCMC() <= availableMana;
        }

        private JsonObject player(PlayerView pv, GameView gv) {
            players.put(pv.getId(), pv);
            final JsonObject o = new JsonObject();
            final boolean mine = isLocalPlayer(pv);
            o.addProperty("id", pv.getId());
            o.addProperty("name", pv.getName());
            o.addProperty("life", pv.getLife());
            o.addProperty("ai", pv.isAI());
            o.addProperty("local", mine);
            o.addProperty("priority", pv.getHasPriority());
            o.addProperty("lost", pv.getHasLost());
            o.addProperty("highlighted", isHighlighted(pv));
            o.addProperty("library", pv.getZoneSize(ZoneType.Library));
            o.addProperty("handSize", pv.getZoneSize(ZoneType.Hand));
            o.add("hand", zone(pv, ZoneType.Hand, !mine)); // the bot's hand is revealed: this is a practice tool
            o.add("battlefield", zone(pv, ZoneType.Battlefield));
            o.add("graveyard", zone(pv, ZoneType.Graveyard));
            o.add("exile", zone(pv, ZoneType.Exile));
            o.add("command", zone(pv, ZoneType.Command));

            final JsonObject mana = new JsonObject();
            for (byte b : new byte[]{MagicColor.WHITE, MagicColor.BLUE, MagicColor.BLACK, MagicColor.RED, MagicColor.GREEN, MagicColor.COLORLESS}) {
                final int n = pv.getMana(b);
                if (n > 0) {
                    mana.addProperty(MagicColor.toShortString(b), n);
                }
            }
            o.add("mana", mana);
            if (mine) {
                o.addProperty("untappedSources", untappedSources);
            }

            // commander damage this player has taken, per enemy commander
            final JsonObject cmd = new JsonObject();
            for (PlayerView other : gv.getPlayers()) {
                if (other != pv && other.getCommanders() != null) {
                    for (CardView c : other.getCommanders()) {
                        final int dmg = pv.getCommanderDamage(c);
                        if (dmg > 0) {
                            cmd.addProperty(c.getCurrentState().getName(), dmg);
                        }
                    }
                }
            }
            o.add("commanderDamage", cmd);
            return o;
        }

        private JsonArray zone(PlayerView pv, ZoneType z) {
            return zone(pv, z, false);
        }

        private JsonArray zone(PlayerView pv, ZoneType z, boolean reveal) {
            final JsonArray a = new JsonArray();
            final Iterable<CardView> cs = pv.getCards(z);
            if (cs != null) {
                for (CardView c : cs) {
                    a.add(card(c, reveal));
                }
            }
            return a;
        }

        private JsonObject card(CardView c) {
            return card(c, false);
        }

        private JsonObject card(CardView c, boolean reveal) {
            cards.put(c.getId(), c);
            final JsonObject o = new JsonObject();
            o.addProperty("id", c.getId());
            o.addProperty("selectable", isSelectable(c));
            o.addProperty("playable", playableNow.contains(c.getId()));
            o.addProperty("highlighted", isHighlighted(c));
            // mana sources usable for the cost being paid (2 = what Forge's "Auto" would tap)
            o.addProperty("manaSource", getWeakSelectableStrength(c));
            if ((!reveal && !mayView(c)) || c.isFaceDown()) {
                o.addProperty("hidden", true);
                o.addProperty("tapped", c.isTapped());
                return o;
            }
            final CardView.CardStateView s = c.getCurrentState();
            o.addProperty("name", s.getName());
            o.addProperty("type", s.getType().toString());
            o.addProperty("text", c.getText());
            o.addProperty("cost", s.getManaCost() == null ? "" : s.getManaCost().toString());
            final boolean creature = s.getType().isCreature();
            o.addProperty("creature", creature);
            o.addProperty("land", s.getType().isLand());
            if (creature) {
                o.addProperty("power", s.getPower());
                o.addProperty("toughness", s.getToughness());
            }
            if (s.getType().isPlaneswalker()) {
                o.addProperty("loyalty", s.getLoyalty());
            }
            o.addProperty("tapped", c.isTapped());
            o.addProperty("sick", c.isSick());
            o.addProperty("token", c.isToken());
            o.addProperty("commander", c.isCommander());
            o.addProperty("damage", c.getDamage());
            o.addProperty("attacking", c.isAttacking());
            o.addProperty("blocking", c.isBlocking());
            if (c.getAttachedTo() != null) {
                o.addProperty("attachedTo", c.getAttachedTo().getId());
            }
            final JsonObject counters = new JsonObject();
            if (c.getCounters() != null) {
                for (CounterType t : c.getCounters().elementSet()) {
                    counters.addProperty(t.getName(), c.getCounters().count(t));
                }
            }
            o.add("counters", counters);
            return o;
        }

        private <T> JsonArray items(List<T> list, FSerializableFunction<T, String> display) {
            final JsonArray a = new JsonArray();
            for (T t : list) {
                final JsonObject o = new JsonObject();
                if (t instanceof CardView c) {
                    final JsonObject cj = card(c);
                    o.addProperty("label", cj.has("name") ? cj.get("name").getAsString() : "Hidden card");
                    o.add("card", cj);
                } else if (t instanceof PlayerView pv) {
                    players.put(pv.getId(), pv);
                    o.addProperty("label", pv.getName());
                } else if (t instanceof SpellAbilityView sa) {
                    o.addProperty("label", sa.toString());
                    if (sa.getHostCard() != null) {
                        o.add("card", card(sa.getHostCard()));
                    }
                } else if (t instanceof GameEntityView g) {
                    o.addProperty("label", g.getName());
                } else {
                    o.addProperty("label", display != null ? display.apply(t) : String.valueOf(t));
                }
                a.add(o);
            }
            return a;
        }

        private static <T> List<T> picked(List<T> choices, JsonElement answer) {
            final List<T> out = new ArrayList<>();
            if (answer != null && answer.isJsonArray()) {
                for (JsonElement e : answer.getAsJsonArray()) {
                    final int i = e.getAsInt();
                    if (i >= 0 && i < choices.size()) {
                        out.add(choices.get(i));
                    }
                }
            }
            return out;
        }

        private static int index(JsonElement answer) {
            return answer != null && answer.isJsonPrimitive() ? answer.getAsInt() : -1;
        }

        private JsonElement chooseRaw(String message, List<?> choices, int min, int max, CardView about) {
            final JsonObject q = new JsonObject();
            q.add("items", items(new ArrayList<Object>(choices), null));
            q.addProperty("min", min);
            q.addProperty("max", max);
            if (about != null) {
                q.add("card", card(about));
            }
            return ask("choose", message, q);
        }

        private JsonElement options(String message, List<String> options, CardView about) {
            final JsonObject q = new JsonObject();
            final JsonArray a = new JsonArray();
            options.forEach(a::add);
            q.add("options", a);
            if (about != null) {
                q.add("card", card(about));
            }
            return ask("options", message, q);
        }

        // -- IGuiGame: display updates (all just bump the version)

        @Override protected void updateCurrentPlayer(PlayerView player) { bump(); }
        @Override public void openView(TrackableCollection<PlayerView> myPlayers) { bump(); }
        @Override public void showCombat() { bump(); }
        @Override public void showPromptMessage(PlayerView playerView, String message, CardView card) {
            final JsonObject shown = card == null ? null : card(card); // e.g. the card a scry asks "top or bottom?" about
            synchronized (lock) {
                prompt = message == null ? "" : message;
                promptCard = shown;
            }
            bump();
        }
        @Override public void updateButtons(PlayerView owner, String label1, String label2, boolean enable1, boolean enable2, boolean focus1) {
            synchronized (lock) {
                okLabel = label1 == null ? "OK" : label1;
                cancelLabel = label2 == null ? "Cancel" : label2;
                okOn = enable1;
                cancelOn = enable2;
            }
            bump();
        }
        @Override public void flashIncorrectAction() { }
        @Override public void alertUser() { }
        @Override public void finishGame() { bump(); }
        @Override public void updatePhase(boolean saveState) { bump(); }
        @Override public void updateTurn(PlayerView player) { bump(); }
        @Override public void updateStack() { bump(); }
        @Override public void updateZones(Iterable<forge.player.PlayerZoneUpdate> zonesToUpdate) { bump(); }
        @Override public void updateCards(Iterable<CardView> cards) { bump(); }
        @Override public void updateLives(Iterable<PlayerView> livesUpdate) { bump(); }
        @Override public void updateManaPool(Iterable<PlayerView> manaPoolUpdate) { bump(); }
        @Override public void refreshField() { bump(); }
        @Override public void setSelectables(Iterable<CardView> cards, int min, int max) { super.setSelectables(cards, min, max); bump(); }
        @Override public void clearSelectables() { super.clearSelectables(); bump(); }
        @Override public void setWeaklySelectable(Iterable<CardView> cards) { super.setWeaklySelectable(cards); bump(); }
        @Override public void clearWeaklySelectable() { super.clearWeaklySelectable(); bump(); }
        @Override public forge.game.GameState getGamestate() { return null; }
        @Override public void setPanelSelection(CardView hostCard) { }
        @Override public void setCard(CardView card) { }
        @Override public void setPlayerAvatar(LobbyPlayer player, IHasIcon ihi) { }

        /**
         * Always stop in your own main phases. At the usual response windows (the bot's attack, blocks
         * and end step, and your own blocks step) stop only if you actually hold an instant-speed play.
         * Everything else flows by. Called on the game thread, so reading the game here is safe.
         */
        @Override public boolean isUiSetToSkipPhase(PlayerView playerTurn, PhaseType phase) {
            final boolean mine = isLocalPlayer(playerTurn);
            if (mine && (phase == PhaseType.MAIN1 || phase == PhaseType.MAIN2)) {
                return false;
            }
            final boolean window = mine
                    ? phase == PhaseType.COMBAT_DECLARE_BLOCKERS
                    : phase == PhaseType.COMBAT_DECLARE_ATTACKERS || phase == PhaseType.COMBAT_DECLARE_BLOCKERS || phase == PhaseType.END_OF_TURN;
            if (!window) {
                return true;
            }
            try {
                return actions(getGameView(), true).isEmpty();
            } catch (RuntimeException e) {
                return true;
            }
        }

        // -- IGuiGame: questions (block the game thread until answered)

        @Override public void message(String message, String title) { notice(message); }
        @Override public void showErrorDialog(String message, String title) { notice(message); }

        @Override public boolean showConfirmDialog(String message, String title, String yes, String no, boolean defaultYes) {
            return index(options(message, List.of(yes, no), null)) == 0;
        }

        @Override public int showOptionDialog(String message, String title, FSkinProp icon, List<String> options, int defaultOption) {
            final int i = index(options(message, options, null));
            return i < 0 ? defaultOption : i;
        }

        @Override public String showInputDialog(String message, String title, FSkinProp icon, String initialInput, List<String> inputOptions, boolean isNumeric) {
            if (inputOptions != null && !inputOptions.isEmpty()) {
                final int i = index(options(message, inputOptions, null));
                return i < 0 ? null : inputOptions.get(i);
            }
            final JsonObject q = new JsonObject();
            q.addProperty("numeric", isNumeric);
            q.addProperty("initial", initialInput == null ? "" : initialInput);
            final JsonElement r = ask("input", message, q);
            return r == null || r.isJsonNull() ? null : r.getAsString();
        }

        @Override public boolean confirm(CardView c, String question, boolean defaultIsYes, List<String> options) {
            return index(options(question, options, c)) == 0;
        }

        @Override public <T> List<T> getChoices(String message, int min, int max, List<T> choices, List<T> selected, FSerializableFunction<T, String> display) {
            if (choices == null || choices.isEmpty()) {
                return new ArrayList<>();
            }
            if (min < 0 && max < 0) { // Forge's "reveal": just show it
                final StringBuilder sb = new StringBuilder(message == null ? "" : message);
                for (T t : choices) {
                    sb.append("\n• ").append(display != null ? display.apply(t) : t instanceof CardView cv ? cv.getCurrentState().getName() : String.valueOf(t));
                }
                notice(sb.toString());
                return new ArrayList<>();
            }
            final JsonObject q = new JsonObject();
            q.add("items", items(choices, display));
            q.addProperty("min", min);
            q.addProperty("max", max);
            return picked(choices, ask("choose", message, q));
        }

        @Override public <T> List<T> many(String title, String topCaption, int min, int max, List<T> sourceChoices, List<T> destChoices, CardView c) {
            final String msg = topCaption == null || topCaption.isBlank() ? title : title + " — " + topCaption;
            return getChoices(msg, Math.max(0, min), max < 0 ? sourceChoices.size() : max, sourceChoices, null, null);
        }

        @Override public Integer getInteger(String message, int min, int max, boolean sortDesc) {
            return number(message, min, max);
        }

        @Override public Integer getInteger(String message, int min, int max, int cutoff) {
            return number(message, min, max);
        }

        private Integer number(String message, int min, int max) {
            if (max <= min) {
                return min;
            }
            final JsonObject q = new JsonObject();
            q.addProperty("min", min);
            q.addProperty("max", max);
            final JsonElement r = ask("number", message, q);
            return r == null || r.isJsonNull() ? null : Math.max(min, Math.min(max, r.getAsInt()));
        }

        @Override public <T> OrderResult<T> order(String title, String top, int remainingObjectsMin, int remainingObjectsMax, List<T> sourceChoices, List<T> destChoices, CardView referenceCard, boolean sideboardingMode, boolean showRememberCheckbox) {
            final int n = sourceChoices.size();
            if (n <= 1 && remainingObjectsMax <= 0) {
                return new OrderResult<>(new ArrayList<>(sourceChoices), false);
            }
            final JsonObject q = new JsonObject();
            q.add("items", items(sourceChoices, null));
            q.addProperty("min", Math.max(0, n - Math.max(0, remainingObjectsMax)));
            q.addProperty("max", n - Math.max(0, remainingObjectsMin));
            q.addProperty("ordered", true);
            final List<T> out = picked(sourceChoices, ask("choose", top == null || top.isBlank() ? title : title + " — " + top, q));
            return new OrderResult<>(out.isEmpty() && remainingObjectsMax <= 0 ? new ArrayList<>(sourceChoices) : out, false);
        }

        @Override public SpellAbilityView getAbilityToPlay(CardView hostCard, List<SpellAbilityView> abilities, ITriggerEvent triggerEvent) {
            if (abilities.isEmpty()) {
                return null; // nothing usable right now (e.g. Cabal Coffers whose {2} can't be paid)
            }
            if (abilities.size() == 1) {
                return abilities.get(0); // a click on a card with one thing to do just does it
            }
            final List<SpellAbilityView> r = picked(abilities, chooseRaw("Choose what to do with " + hostCard.getCurrentState().getName(), abilities, 0, 1, hostCard));
            return r.isEmpty() ? null : r.get(0);
        }

        @Override public GameEntityView chooseSingleEntityForEffect(String title, List<? extends GameEntityView> optionList, DelayedReveal delayedReveal, boolean isOptional) {
            final List<GameEntityView> opts = new ArrayList<>(optionList);
            if (opts.isEmpty()) {
                return null;
            }
            final List<GameEntityView> r = picked(opts, chooseRaw(title, opts, isOptional ? 0 : 1, 1, null));
            return r.isEmpty() ? (isOptional ? null : opts.get(0)) : r.get(0);
        }

        @Override public List<GameEntityView> chooseEntitiesForEffect(String title, List<? extends GameEntityView> optionList, int min, int max, DelayedReveal delayedReveal) {
            final List<GameEntityView> opts = new ArrayList<>(optionList);
            return opts.isEmpty() ? opts : picked(opts, chooseRaw(title, opts, min, max, null));
        }

        @Override public List<CardView> manipulateCardList(String title, Iterable<CardView> cards, Iterable<CardView> manipulable, boolean toTop, boolean toBottom, boolean toAnywhere) {
            final List<CardView> out = new ArrayList<>();
            cards.forEach(out::add);
            return out;
        }

        @Override public List<PaperCard> sideboard(CardPool sideboard, CardPool main, String message) {
            return null; // no sideboarding in Commander
        }

        /** Default combat damage split: lethal to each blocker in order, the rest tramples over (or piles on the last blocker). */
        @Override public Map<CardView, Integer> assignCombatDamage(CardView attacker, List<CardView> blockers, int damage, GameEntityView defender, boolean overrideOrder, boolean maySkip) {
            final Map<CardView, Integer> m = new HashMap<>();
            final boolean deathtouch = attacker.getCurrentState().hasDeathtouch();
            final boolean spill = defender != null && attacker.getCurrentState().hasTrample();
            int left = damage;
            for (int i = 0; i < blockers.size() && left > 0; i++) {
                final CardView b = blockers.get(i);
                final boolean last = i == blockers.size() - 1;
                final int give = last && !spill ? left : Math.min(left, deathtouch ? 1 : Math.max(0, b.getLethalDamage()));
                if (give > 0) {
                    m.put(b, give);
                }
                left -= give;
            }
            if (left > 0) {
                if (spill || blockers.isEmpty()) {
                    m.put(null, left); // null = the defending player/planeswalker
                } else {
                    m.merge(blockers.get(blockers.size() - 1), left, Integer::sum);
                }
            }
            return m;
        }

        @Override public Map<Object, Integer> assignGenericAmount(CardView effectSource, Map<Object, Integer> target, int amount, boolean atLeastOne, String amountLabel) {
            final List<Object> keys = new ArrayList<>(target.keySet());
            final JsonObject q = new JsonObject();
            q.add("items", items(keys, o -> o instanceof Byte b ? MagicColor.toLongString(b) : String.valueOf(o)));
            q.addProperty("amount", amount);
            q.addProperty("atLeastOne", atLeastOne);
            q.addProperty("label", amountLabel == null ? "" : amountLabel);
            if (effectSource != null) {
                q.add("card", card(effectSource));
            }
            final JsonElement r = ask("distribute", "Distribute " + amount + " " + (amountLabel == null ? "" : amountLabel), q);
            final Map<Object, Integer> out = new HashMap<>();
            if (r != null && r.isJsonArray() && r.getAsJsonArray().size() == keys.size()) {
                for (int i = 0; i < keys.size(); i++) {
                    out.put(keys.get(i), r.getAsJsonArray().get(i).getAsInt());
                }
            } else { // fall back to an even split
                for (int i = 0; i < keys.size(); i++) {
                    out.put(keys.get(i), amount / keys.size() + (i < amount % keys.size() ? 1 : 0));
                }
            }
            return out;
        }
    }
}
