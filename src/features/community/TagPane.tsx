/*
 * Trae 社区 · 所有标签
 * ------------------------------------------------------------------
 * 数据来自 `/tags.json`：
 *   - `tags`：站点热门标签（实测 65 个），每项带 count；
 *   - `extras.tag_groups`：后台配置的分组（实测 5 组 / 33 个），组内 tag 带 count。
 * 这两批标签实测**互不重叠**，所以这里先合并再展示：
 *   - 有分组 → 按「分组 + 主题数」呈现，剩余标签按计数排序平铺；
 *   - 没分组 → 全部按计数排序平铺，并在页脚标注数据来源。
 * 点任意标签回到列表并按该标签筛选（走 /tag/{name}.json）。
 * @Author: fu
 */
import { Button, Skeleton } from 'antd';
import { ReloadOutlined, TagOutlined } from '@ant-design/icons';
import { useCommunityStore } from './store';
import { formatCount } from './format';
import { SectionError } from './bits';
import type { TagView } from './types';

export function TagPane() {
  const catalog = useCommunityStore((s) => s.tagCatalog);
  const loading = useCommunityStore((s) => s.tagsLoading);
  const error = useCommunityStore((s) => s.tagsError);
  const loadTags = useCommunityStore((s) => s.loadTags);
  const setTag = useCommunityStore((s) => s.setTag);

  if (loading && !catalog) {
    return (
      <div className="cm-tagpane">
        <div className="cm-tagpane-head">
          <h2>所有标签</h2>
          <span className="cm-list-count">首次加载会稍慢一点</span>
        </div>
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  if (error && !catalog) {
    return (
      <div className="cm-tagpane">
        <SectionError message={error} onRetry={() => void loadTags(true)} />
      </div>
    );
  }

  if (!catalog) return null;

  const pick = (tag: TagView) => {
    void setTag(tag.name);
  };

  return (
    <div className="cm-tagpane">
      <div className="cm-tagpane-head">
        <div className="cm-list-head-left">
          <h2>
            <TagOutlined /> 所有标签
          </h2>
          <span className="cm-list-count">
            {catalog.flat.length} 个标签
            {catalog.grouped ? ` · ${catalog.groups.length} 个分组` : ' · 接口未返回分组'}
          </span>
        </div>
        <Button size="small" icon={<ReloadOutlined />} onClick={() => void loadTags(true)}>
          刷新
        </Button>
      </div>

      {error && (
        <div className="cm-banner is-error">
          <span>标签刷新失败：{error}</span>
          <button type="button" onClick={() => void loadTags(true)}>重试</button>
        </div>
      )}

      {catalog.grouped ? (
        <>
          {catalog.groups.map((group) => (
            <section className="cm-taggroup" key={group.id}>
              <div className="cm-taggroup-head">
                <h3>{group.name}</h3>
                <span>{group.tags.length} 个标签</span>
              </div>
              <div className="cm-taggrid">
                {group.tags.map((tag) => (
                  <TagCard key={`${group.id}-${tag.name}`} tag={tag} onClick={() => pick(tag)} />
                ))}
              </div>
            </section>
          ))}

          {catalog.ungrouped.length > 0 && (
            <section className="cm-taggroup">
              <div className="cm-taggroup-head">
                <h3>未分组标签</h3>
                <span>{catalog.ungrouped.length} 个 · 按主题数排序</span>
              </div>
              <div className="cm-taggrid">
                {catalog.ungrouped.map((tag) => (
                  <TagCard key={`free-${tag.name}`} tag={tag} onClick={() => pick(tag)} />
                ))}
              </div>
            </section>
          )}
        </>
      ) : (
        <section className="cm-taggroup">
          <div className="cm-taggroup-head">
            <h3>全部标签</h3>
            <span>{catalog.flat.length} 个 · 按主题数排序</span>
          </div>
          <div className="cm-taggrid">
            {catalog.flat.map((tag) => (
              <TagCard key={tag.name} tag={tag} onClick={() => pick(tag)} />
            ))}
          </div>
        </section>
      )}

      <p className="cm-tagpane-source">
        数据来源：<code>forum.trae.cn/tags.json</code>
        {' '}· 分组来自 <code>extras.tag_groups</code>
        {' '}· 计数为该标签下的主题数（与官方「所有标签」页一致）。
        顶层 tags 与分组是两批不同的标签，本页已合并去重。
      </p>
    </div>
  );
}

function TagCard({ tag, onClick }: { tag: TagView; onClick: () => void }) {
  return (
    <button type="button" className="cm-tagcard" onClick={onClick} title={tag.description || tag.name}>
      <span className="cm-tagcard-name">#{tag.name}</span>
      <span className="cm-tagcard-count">{formatCount(tag.count)}</span>
      {tag.description && <span className="cm-tagcard-desc">{tag.description}</span>}
    </button>
  );
}
