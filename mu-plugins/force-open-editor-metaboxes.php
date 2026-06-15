<?php
/**
 * Plugin Name: Force Open Editor Meta Boxes
 * Description: WordPress 7.0+ のブロックエディタで、下部メタボックス領域を初期表示から開く。
 */

add_action('enqueue_block_editor_assets', function () {
    $screen = function_exists('get_current_screen') ? get_current_screen() : null;

    // 投稿・固定ページ・カスタム投稿タイプの編集画面だけ対象
    if (!$screen || $screen->base !== 'post') {
        return;
    }

    /*
     * 必要なら投稿タイプを絞る
     *
     * $target_post_types = ['post', 'page', 'news'];
     * if (!in_array($screen->post_type, $target_post_types, true)) {
     *     return;
     * }
     */

    $js_path = __DIR__ . '/force-open-editor-metaboxes/script.js';
    $js_url  = plugin_dir_url(__FILE__) . 'force-open-editor-metaboxes/script.js';

    wp_enqueue_script(
        'force-open-editor-metaboxes',
        $js_url,
        ['wp-data', 'wp-dom-ready'],
        file_exists($js_path) ? filemtime($js_path) : '1.0.0',
        true
    );
});