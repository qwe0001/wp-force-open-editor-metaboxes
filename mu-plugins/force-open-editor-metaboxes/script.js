(function () {
    const DEBUG = false;
    const LOG_PREFIX = '[force-open-metaboxes]';

    function log(...args) {
        if (DEBUG) {
            console.log(LOG_PREFIX, ...args);
        }
    }

    log('script loaded');

    const PREF_SCOPE = 'core/edit-post';
    const PREF_IS_OPEN = 'metaBoxesMainIsOpen';
    const PREF_OPEN_HEIGHT = 'metaBoxesMainOpenHeight';

    const BOTTOM_THRESHOLD = 24;
    const TOP_THRESHOLD = 2;
    const REOPEN_LOCK_MS = 450;
    const MAX_HEIGHT_RATIO = 0.5;
    const PREFERRED_HEIGHT_RATIO = 0.45;

    const INITIAL_OPEN_LOCK_MS = 1200;
    const POST_OPEN_SETUP_MS = 50;

    let mainScroller = null;
    let bound = false;
    let reopenLockedUntil = 0;
    let autoOpenLockedUntil = Date.now() + INITIAL_OPEN_LOCK_MS;
    let metaBoxScrollElement = null;
    let metaBoxPrevScrollTop = 0;

    function getPreferencesDispatch() {
        if (!window.wp || !wp.data || typeof wp.data.dispatch !== 'function') {
            return null;
        }

        const preferences = wp.data.dispatch('core/preferences');

        if (!preferences || typeof preferences.set !== 'function') {
            return null;
        }

        return preferences;
    }

    function getPreferencesSelect() {
        if (!window.wp || !wp.data || typeof wp.data.select !== 'function') {
            return null;
        }

        const preferences = wp.data.select('core/preferences');

        if (!preferences || typeof preferences.get !== 'function') {
            return null;
        }

        return preferences;
    }

    function getEditorContentContainer() {
        const pane = getMetaBoxPane();

        if (pane) {
            const container = pane.closest('.interface-interface-skeleton__content');

            if (container) {
                return container;
            }
        }

        return document.querySelector('.interface-interface-skeleton__content');
    }

    function getAvailableEditorHeight() {
        const container = getEditorContentContainer();

        if (!container) {
            return window.innerHeight || 900;
        }

        const noticeContainer = container.querySelector(
            ':scope > .notices-inline-notices-wrapper'
        );
        let availableHeight = container.offsetHeight;

        if (noticeContainer) {
            availableHeight -= noticeContainer.offsetHeight;
        }

        return Math.max(0, availableHeight);
    }

    function getMetaBoxHeightLimits() {
        const minHeight = getMetaBoxMinHeight();
        const availableHeight = getAvailableEditorHeight();
        const maxHeight = Math.max(
            minHeight,
            Math.round(availableHeight * MAX_HEIGHT_RATIO)
        );

        return {
            min: minHeight,
            max: maxHeight,
            availableHeight
        };
    }

    function clampPaneHeight(height) {
        const limits = getMetaBoxHeightLimits();

        return Math.min(
            limits.max,
            Math.max(limits.min, Math.round(height))
        );
    }

    function getOpenHeight() {
        const limits = getMetaBoxHeightLimits();
        const preferred = Math.round(limits.availableHeight * PREFERRED_HEIGHT_RATIO);

        return clampPaneHeight(preferred);
    }

    function getSavedOpenHeight() {
        const preferences = getPreferencesSelect();

        if (!preferences) {
            return null;
        }

        const height = preferences.get(PREF_SCOPE, PREF_OPEN_HEIGHT);

        return typeof height === 'number' && height > 0 ? height : null;
    }

    function getCurrentMetaBoxHeight() {
        const pane = getMetaBoxPane();

        if (isMetaBoxesOpen() && pane) {
            return clampPaneHeight(pane.offsetHeight);
        }

        const savedHeight = getSavedOpenHeight();

        if (savedHeight !== null) {
            return clampPaneHeight(savedHeight);
        }

        return getMetaBoxMinHeight();
    }

    function isMetaBoxesOpen() {
        const preferences = getPreferencesSelect();

        if (!preferences) {
            return false;
        }

        return !!preferences.get(PREF_SCOPE, PREF_IS_OPEN);
    }

    function getMetaBoxMinHeight() {
        const presenter = document.querySelector('.edit-post-meta-boxes-main__presenter');

        return presenter ? presenter.offsetHeight : 36;
    }

    function setMetaBoxesOpen(open) {
        const preferences = getPreferencesDispatch();

        if (!preferences) {
            log('setMetaBoxesOpen: preferences unavailable', { open });
            return false;
        }

        if (open) {
            if (isMetaBoxesOpen()) {
                return false;
            }

            const height = getOpenHeight();
            preferences.set(PREF_SCOPE, PREF_OPEN_HEIGHT, height);
            preferences.set(PREF_SCOPE, PREF_IS_OPEN, true);
            log('setMetaBoxesOpen: open', { height });
        } else {
            if (!isMetaBoxesOpen()) {
                return false;
            }

            preferences.set(PREF_SCOPE, PREF_IS_OPEN, false);
            preferences.set(PREF_SCOPE, PREF_OPEN_HEIGHT, getOpenHeight());
            log('setMetaBoxesOpen: close');
        }

        return true;
    }

    function describeScroller(scroller) {
        if (!scroller) {
            return 'null';
        }

        if (scroller === window) {
            return 'window';
        }

        const className = scroller.className
            ? String(scroller.className).split(/\s+/).slice(0, 2).join('.')
            : '';

        return scroller.tagName.toLowerCase() + (className ? '.' + className : '');
    }

    function getMetaBoxPane() {
        return document.querySelector('.edit-post-meta-boxes-main');
    }

    function getMetaBoxScroller() {
        const pane = getMetaBoxPane();

        if (!pane) {
            return null;
        }

        const liner = getMetaBoxLiner();
        const candidates = [liner, pane].filter(Boolean);
        let best = null;
        let bestScrollRange = 0;

        function consider(element) {
            if (!isScrollableElement(element)) {
                return;
            }

            const range = element.scrollHeight - element.clientHeight;

            if (range > bestScrollRange) {
                bestScrollRange = range;
                best = element;
            }
        }

        for (let i = 0; i < candidates.length; i++) {
            consider(candidates[i]);
        }

        const descendants = pane.querySelectorAll('*');

        for (let i = 0; i < descendants.length; i++) {
            consider(descendants[i]);
        }

        if (best) {
            return best;
        }

        return pane;
    }

    function isMetaBoxScrollerAtTop(scroller) {
        return getScrollTop(scroller) <= TOP_THRESHOLD;
    }

    function tryCloseMetaBoxesOnUpwardScrollAtTop(source, scrolledUp, context) {
        context = context || {};

        if (!scrolledUp) {
            log('close check: skip (not upward)', { source, ...context });
            return false;
        }

        if (!isMetaBoxesOpen()) {
            log('close check: skip (metabox not open)', { source, ...context });
            return false;
        }

        const boundScroller = metaBoxScrollElement || getMetaBoxScroller();

        if (!boundScroller) {
            log('close check: skip (no bound scroller)', { source, ...context });
            return false;
        }

        const boundScrollTop = getScrollTop(boundScroller);

        if (!isMetaBoxScrollerAtTop(boundScroller)) {
            log('close check: skip (bound scroller not at top)', {
                source,
                boundScroller: describeScroller(boundScroller),
                boundScrollTop,
                threshold: TOP_THRESHOLD,
                ...context
            });
            return false;
        }

        log('close triggered: upward scroll at top', {
            source,
            boundScroller: describeScroller(boundScroller),
            boundScrollTop,
            ...context
        });
        closeMetaBoxesToBodyEnd(source);
        return true;
    }

    function onMetaBoxScroll() {
        if (!isMetaBoxesOpen()) {
            return;
        }

        const scroller = metaBoxScrollElement || getMetaBoxScroller();

        if (!scroller) {
            log('metabox scroll: no scroller');
            return;
        }

        const scrollTop = getScrollTop(scroller);
        const scrolledUp = scrollTop < metaBoxPrevScrollTop;
        const atTop = isMetaBoxScrollerAtTop(scroller);

        if (scrolledUp || atTop) {
            log('metabox scroll', {
                scroller: describeScroller(scroller),
                scrollTop,
                prevScrollTop: metaBoxPrevScrollTop,
                scrolledUp,
                atTop
            });
        }

        tryCloseMetaBoxesOnUpwardScrollAtTop('metabox-scroll', scrolledUp, {
            eventScrollTop: scrollTop,
            prevScrollTop: metaBoxPrevScrollTop
        });

        metaBoxPrevScrollTop = scrollTop;
    }

    function shouldIgnoreMetaBoxWheel(event) {
        const interactiveScrollable = event.target.closest(
            'textarea, .acf-editor-wrap, .wp-editor-wrap, .wp-editor-area, iframe'
        );

        return !!interactiveScrollable;
    }

    function describeEventTarget(target) {
        if (!target || !target.tagName) {
            return '(unknown)';
        }

        const className = target.className
            ? String(target.className).split(/\s+/).slice(0, 2).join('.')
            : '';

        return target.tagName.toLowerCase() + (className ? '.' + className : '');
    }

    function onMetaBoxWheel(event) {
        const pane = getMetaBoxPane();

        if (!pane || !pane.contains(event.target)) {
            return;
        }

        if (event.deltaY >= 0) {
            return;
        }

        const boundScroller = metaBoxScrollElement || getMetaBoxScroller();
        const ancestorScroller = findScrollableAncestor(event.target, pane);
        const ignored = shouldIgnoreMetaBoxWheel(event);

        log('metabox wheel: up', {
            deltaY: event.deltaY,
            target: describeEventTarget(event.target),
            isOpen: isMetaBoxesOpen(),
            ignored,
            boundScroller: describeScroller(boundScroller),
            boundScrollTop: boundScroller ? getScrollTop(boundScroller) : null,
            ancestorScroller: describeScroller(ancestorScroller),
            ancestorScrollTop: ancestorScroller ? getScrollTop(ancestorScroller) : null
        });

        if (!isMetaBoxesOpen()) {
            log('metabox wheel: skip (metabox not open)');
            return;
        }

        if (ignored) {
            log('metabox wheel: skip (interactive element)', {
                ignoredElement: describeEventTarget(
                    event.target.closest('textarea, .acf-editor-wrap, .wp-editor-wrap, .wp-editor-area, iframe')
                )
            });
            return;
        }

        if (!boundScroller) {
            log('metabox wheel: skip (no bound scroller)');
            return;
        }

        if (!isMetaBoxScrollerAtTop(boundScroller)) {
            log('metabox wheel: skip (bound scroller not at top)', {
                boundScrollTop: getScrollTop(boundScroller),
                threshold: TOP_THRESHOLD
            });
            return;
        }

        if (ancestorScroller && ancestorScroller !== boundScroller && !isMetaBoxScrollerAtTop(ancestorScroller)) {
            log('metabox wheel: skip (inner scroller not at top)', {
                ancestorScroller: describeScroller(ancestorScroller),
                ancestorScrollTop: getScrollTop(ancestorScroller)
            });
            return;
        }

        if (tryCloseMetaBoxesOnUpwardScrollAtTop('metabox-wheel', true, {
            target: describeEventTarget(event.target),
            deltaY: event.deltaY
        })) {
            event.preventDefault();
        }
    }

    function bindMetaBoxScroll() {
        const scroller = getMetaBoxScroller();

        if (!scroller) {
            return;
        }

        if (scroller === metaBoxScrollElement) {
            metaBoxPrevScrollTop = getScrollTop(scroller);
            return;
        }

        if (metaBoxScrollElement) {
            metaBoxScrollElement.removeEventListener('scroll', onMetaBoxScroll);
        }

        metaBoxScrollElement = scroller;
        metaBoxPrevScrollTop = getScrollTop(scroller);
        scroller.addEventListener('scroll', onMetaBoxScroll, { passive: true });
        log('metabox scroll bound', {
            scroller: describeScroller(scroller),
            scrollTop: metaBoxPrevScrollTop
        });
    }

    function resetMetaBoxScrollState() {
        metaBoxPrevScrollTop = 0;

        if (metaBoxScrollElement) {
            metaBoxPrevScrollTop = getScrollTop(metaBoxScrollElement);
        }
    }

    function getMetaBoxLiner() {
        return document.querySelector(
            '.edit-post-meta-boxes-main .edit-post-meta-boxes-main__liner, ' +
            '.edit-post-layout__metaboxes'
        );
    }

    function isScrollableElement(element) {
        if (!element || element === document || element === window) {
            return false;
        }

        const style = window.getComputedStyle(element);
        const overflowY = style.overflowY;

        return (
            /auto|scroll|overlay/.test(overflowY) &&
            element.scrollHeight > element.clientHeight + 2
        );
    }

    function findScrollableAncestor(start, stopAt) {
        let element = start;

        while (element && element !== document.body) {
            if (isScrollableElement(element)) {
                return element;
            }

            if (stopAt && element === stopAt) {
                break;
            }

            element = element.parentElement;
        }

        if (stopAt && isScrollableElement(stopAt)) {
            return stopAt;
        }

        return null;
    }

    function getScrollTop(scroller) {
        if (!scroller) {
            return 0;
        }

        if (scroller === window) {
            return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
        }

        return scroller.scrollTop;
    }

    function getScrollHeight(scroller) {
        if (!scroller) {
            return 0;
        }

        if (scroller === window) {
            return Math.max(
                document.documentElement.scrollHeight,
                document.body.scrollHeight
            );
        }

        return scroller.scrollHeight;
    }

    function getClientHeight(scroller) {
        if (!scroller) {
            return 0;
        }

        if (scroller === window) {
            return window.innerHeight || document.documentElement.clientHeight;
        }

        return scroller.clientHeight;
    }

    function setScrollTop(scroller, value) {
        if (!scroller) {
            return;
        }

        if (scroller === window) {
            window.scrollTo(0, value);
            return;
        }

        scroller.scrollTop = value;
    }

    function isAtBottom(scroller) {
        if (!scroller) {
            return false;
        }

        const scrollTop = getScrollTop(scroller);
        const clientHeight = getClientHeight(scroller);
        const scrollHeight = getScrollHeight(scroller);

        return scrollTop + clientHeight >= scrollHeight - BOTTOM_THRESHOLD;
    }

    function scrollMainToBottom(offset) {
        const scroller = mainScroller || findMainScroller();

        if (!scroller) {
            return;
        }

        const nextTop = Math.max(
            0,
            getScrollHeight(scroller) - getClientHeight(scroller) - (offset || 0)
        );

        setScrollTop(scroller, nextTop);
    }

    function findEditorCanvasIframes() {
        const selectors = [
            '.editor-visual-editor.is-iframed iframe',
            '.edit-post-visual-editor.is-iframed iframe',
            '.editor-visual-editor iframe',
            '.edit-post-visual-editor iframe',
            'iframe[name="editor-canvas"]',
            'iframe.block-editor-iframe__html',
            'iframe.editor-canvas'
        ];
        const seen = new Set();
        const iframes = [];

        selectors.forEach(function (selector) {
            document.querySelectorAll(selector).forEach(function (iframe) {
                if (!seen.has(iframe)) {
                    seen.add(iframe);
                    iframes.push(iframe);
                }
            });
        });

        return iframes;
    }

    function getIframeScroller(iframe) {
        if (!iframe) {
            return null;
        }

        let doc;

        try {
            doc = iframe.contentDocument;
        } catch (error) {
            log('iframe: contentDocument blocked', {
                name: iframe.name || '(no name)',
                className: iframe.className || '(no class)'
            });
            return null;
        }

        if (!doc || !doc.documentElement) {
            return null;
        }

        return doc.scrollingElement || doc.documentElement || doc.body;
    }

    function findMainScroller() {
        const metaBoxPane = getMetaBoxPane();
        const iframes = findEditorCanvasIframes();

        for (let i = 0; i < iframes.length; i++) {
            const scroller = getIframeScroller(iframes[i]);

            if (scroller) {
                log('findMainScroller: iframe scroller', {
                    iframe: iframes[i].name || iframes[i].className || '(anonymous)',
                    scrollHeight: scroller.scrollHeight,
                    clientHeight: scroller.clientHeight
                });
                return scroller;
            }
        }

        const selectors = [
            '.interface-interface-skeleton__content',
            '.block-editor-editor-skeleton__content',
            '.edit-post-layout__content',
            '.editor-visual-editor'
        ];

        const candidates = selectors
            .map((selector) => document.querySelector(selector))
            .filter(Boolean)
            .filter((element) => {
                return !metaBoxPane || !metaBoxPane.contains(element);
            })
            .filter((element) => element.scrollHeight > element.clientHeight + 10);

        if (candidates.length) {
            const scroller = candidates.sort((a, b) => {
                const aScrollable = a.scrollHeight - a.clientHeight;
                const bScrollable = b.scrollHeight - b.clientHeight;
                return bScrollable - aScrollable;
            })[0];

            log('findMainScroller: div scroller', {
                scroller: describeScroller(scroller)
            });
            return scroller;
        }

        if (document.documentElement.scrollHeight > window.innerHeight + 10) {
            log('findMainScroller: window');
            return window;
        }

        log('findMainScroller: not found', {
            iframedEditor: !!document.querySelector('.editor-visual-editor.is-iframed'),
            iframeCount: document.querySelectorAll('iframe').length,
            editorIframes: findEditorCanvasIframes().length
        });

        return null;
    }

    function bindIframeScroller(iframe) {
        const scroller = getIframeScroller(iframe);

        if (!scroller) {
            return false;
        }

        iframe.dataset.forceOpenMetaboxesBound = '1';
        mainScroller = scroller;

        log('iframe ready', {
            name: iframe.name || '(no name)',
            className: iframe.className || '(no class)',
            scrollHeight: scroller.scrollHeight,
            clientHeight: scroller.clientHeight
        });

        return true;
    }

    function bindIframeScrolls() {
        const iframes = findEditorCanvasIframes();
        let ready = false;

        iframes.forEach(function (iframe) {
            if (iframe.dataset.forceOpenMetaboxesBound === '1') {
                if (getIframeScroller(iframe)) {
                    ready = true;
                }
                return;
            }

            if (bindIframeScroller(iframe)) {
                ready = true;
                return;
            }

            if (iframe.dataset.forceOpenMetaboxesLoadBound === '1') {
                return;
            }

            iframe.dataset.forceOpenMetaboxesLoadBound = '1';
            log('iframe: waiting for load', {
                name: iframe.name || '(no name)',
                className: iframe.className || '(no class)',
                src: iframe.src || '(no src)'
            });

            iframe.addEventListener('load', function () {
                log('iframe: load event', {
                    name: iframe.name || '(no name)',
                    className: iframe.className || '(no class)'
                });

                bindIframeScroller(iframe);

                if (!bound) {
                    bind();
                }
            }, { once: true });
        });

        return ready;
    }

    function afterOpenMetaBoxesSetup() {
        window.setTimeout(function () {
            const pane = getMetaBoxPane();
            const liner = getMetaBoxLiner();

            if (pane) {
                pane.scrollTop = 0;
            }

            const scrollable = liner ? findScrollableAncestor(liner, pane) : null;

            if (scrollable) {
                scrollable.scrollTop = 0;
            }

            bindMetaBoxScroll();
            resetMetaBoxScrollState();
        }, POST_OPEN_SETUP_MS);
    }

    function openMetaBoxesToTargetHeight(source) {
        const targetHeight = getOpenHeight();
        const preferences = getPreferencesDispatch();

        if (!preferences) {
            return;
        }

        const isOpen = isMetaBoxesOpen();
        const currentHeight = isOpen ? getCurrentMetaBoxHeight() : getMetaBoxMinHeight();
        const savedHeight = getSavedOpenHeight();

        log('open to target', {
            source,
            targetHeight,
            currentHeight,
            savedHeight,
            isOpen
        });

        if (isOpen && currentHeight === targetHeight) {
            log('open skipped: already at target height', { source });
            return;
        }

        // 手動リサイズで保存された高さより先に目標高さをセットしてから開く
        preferences.set(PREF_SCOPE, PREF_OPEN_HEIGHT, targetHeight);
        preferences.set(PREF_SCOPE, PREF_IS_OPEN, true);
        afterOpenMetaBoxesSetup();
    }

    function openMetaBoxesFromBodyEnd(source) {
        const now = Date.now();

        if (now < reopenLockedUntil) {
            log('open skipped: reopen lock', { source, remainingMs: reopenLockedUntil - now });
            return;
        }

        if (now < autoOpenLockedUntil) {
            log('open skipped: initial lock', { source, remainingMs: autoOpenLockedUntil - now });
            return;
        }

        log('open triggered', { source, scroller: describeScroller(mainScroller || findMainScroller()) });
        openMetaBoxesToTargetHeight(source);
    }

    function closeMetaBoxesToBodyEnd(source) {
        log('close triggered', { source, lockMs: REOPEN_LOCK_MS });
        resetMetaBoxScrollState();

        reopenLockedUntil = Date.now() + REOPEN_LOCK_MS;

        setMetaBoxesOpen(false);

        window.setTimeout(function () {
            scrollMainToBottom(4);
        }, POST_OPEN_SETUP_MS);
    }

    function isEventInsideMetaBox(event) {
        const pane = getMetaBoxPane();

        return !!pane && pane.contains(event.target);
    }

    function onMainScroll(event) {
        if (isEventInsideMetaBox(event)) {
            return;
        }

        const scroller = mainScroller || findMainScroller();

        if (!scroller) {
            return;
        }

        if (isAtBottom(scroller)) {
            openMetaBoxesFromBodyEnd('main-scroll');
        }
    }

    function onMainWheel(event) {
        if (isEventInsideMetaBox(event)) {
            return;
        }

        if (event.deltaY <= 0) {
            return;
        }

        const scroller = mainScroller || findMainScroller();

        if (!scroller) {
            return;
        }

        if (isAtBottom(scroller)) {
            openMetaBoxesFromBodyEnd('main-wheel');
        }
    }

    function bind() {
        if (bound) {
            return true;
        }

        bindIframeScrolls();
        mainScroller = findMainScroller();

        if (!mainScroller) {
            log('bind: main scroller not found, waiting for iframe', {
                iframedEditor: !!document.querySelector('.editor-visual-editor.is-iframed'),
                editorIframes: findEditorCanvasIframes().length
            });
            return false;
        }

        // 初期状態では閉じる。
        // 「常に650px占有する」状態を避けるため。
        setMetaBoxesOpen(false);

        if (mainScroller !== window && typeof mainScroller.addEventListener === 'function') {
            mainScroller.addEventListener('scroll', onMainScroll, { passive: true });
            mainScroller.addEventListener('wheel', onMainWheel, { passive: true });
        }

        bindMetaBoxScroll();
        document.addEventListener('wheel', onMetaBoxWheel, { passive: false });
        log('metabox wheel listener bound on document');

        window.addEventListener('resize', function () {
            if (!isMetaBoxesOpen()) {
                return;
            }

            const preferences = getPreferencesDispatch();

            if (preferences) {
                preferences.set(PREF_SCOPE, PREF_OPEN_HEIGHT, getOpenHeight());
            }
        }, { passive: true });

        const observer = new MutationObserver(function () {
            bindIframeScrolls();

            if (!bound && findMainScroller()) {
                bind();
                return;
            }

            bindMetaBoxScroll();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        bound = true;
        log('bind: success', {
            scroller: describeScroller(mainScroller),
            metaBoxPane: !!getMetaBoxPane()
        });

        return true;
    }

    function forceCloseOnLoadImmediate() {
        const preferences = getPreferencesDispatch();

        if (!preferences) {
            log('forceCloseOnLoad: preferences unavailable');
            return false;
        }

        preferences.set(PREF_SCOPE, PREF_IS_OPEN, false);
        preferences.set(PREF_SCOPE, PREF_OPEN_HEIGHT, getOpenHeight());
        log('forceCloseOnLoad: closed');

        return true;
    }

    wp.domReady(function () {
        log('domReady: init start');

        // ページ読み込み直後は、前回保存された開閉状態を信用せず必ず閉じる
        let closeAttempts = 0;

        const closeTimer = window.setInterval(function () {
            closeAttempts += 1;

            if (forceCloseOnLoadImmediate() || closeAttempts >= 20) {
                if (closeAttempts >= 20) {
                    log('forceCloseOnLoad: gave up after retries', { closeAttempts });
                }
                window.clearInterval(closeTimer);
            }
        }, 100);
    
        // Gutenberg側の初期化後に復元されることがあるため、少し遅らせても閉じる
        window.setTimeout(forceCloseOnLoadImmediate, 300);
        window.setTimeout(forceCloseOnLoadImmediate, 800);
        window.setTimeout(forceCloseOnLoadImmediate, 1500);
    
        let attempts = 0;

        const timer = window.setInterval(function () {
            attempts += 1;

            bindIframeScrolls();

            if (bind() || attempts >= 60) {
                if (attempts >= 60 && !bound) {
                    log('bind: gave up after retries', { attempts });
                }
                window.clearInterval(timer);
            }
        }, 200);
    });

    window.addEventListener('pagehide', function () {
        log('pagehide: force close');
        forceCloseOnLoadImmediate();
    });

    window.addEventListener('beforeunload', function () {
        log('beforeunload: force close');
        forceCloseOnLoadImmediate();
    });
})();