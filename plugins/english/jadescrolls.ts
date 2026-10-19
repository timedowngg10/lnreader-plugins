import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { NovelStatus } from '@libs/novelStatus';
import { defaultCover } from '@libs/defaultCover';

const SITE = 'https://jadescrolls.com';
const API = 'https://api.jadescrolls.com/api';

// Turns the site's HTML synopsis into plain text for the summary field.
function htmlToText(html?: string | null): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

class JadeScrollsPlugin implements Plugin.PluginBase {
  id = 'jadescrolls';
  name = 'JadeScrolls';
  icon = 'src/en/jadescrolls/icon.png';
  site = SITE;
  version = '1.0.0';

  // Cache used by search (see searchNovels).
  private novelCache?: Plugin.NovelItem[];
  private authorCache: Record<string, string> = {};

  filters = {
    genre: {
      type: FilterTypes.Picker,
      label: 'Genre',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Fantasy', value: 'c8b536fa-9436-4b93-90fb-8a7bb2be8550' },
        { label: 'Action', value: '34e5c717-8648-4cc1-b796-b6d02d49d170' },
        { label: 'Adventure', value: 'f815320a-34a8-45d7-a461-ef238857c2ed' },
        { label: 'Comedy', value: 'c3c870a5-825c-4f94-b5f6-f51a367fee02' },
        { label: 'Drama', value: 'c4809ae2-f681-4ca8-8201-72278fd7df05' },
        { label: 'Harem', value: 'b22cbc2f-1815-47c0-9fbc-95e7e648b9be' },
        { label: 'Modern', value: 'bd91ba05-0c66-489c-b322-23d679dd5e4d' },
        { label: 'Mystery', value: '4bb0a253-558c-4e32-851d-2c2eabc2ce2e' },
        { label: 'Reincarnation', value: '8d63a221-0f55-4306-b5a1-344bf5f1a8a0' },
        { label: 'Romance', value: '8071a9d5-9e46-42ed-aa3a-bdaabe2b62a7' },
        { label: 'School Life', value: 'd0a1e1c2-b5d2-47e6-9008-a1caabbc15cf' },
        { label: 'Shounen', value: '93996ab2-684d-4b78-afda-3b35ef04afce' },
        { label: 'Supernatural', value: '5c6c028c-0623-4b6d-8e28-b2c4321e1311' },
        { label: 'Transmigration', value: '1e2bcdc8-b21b-4bd4-bdb9-db82642c4b89' },
      ],
    },
  } satisfies Filters;

  // ---------------------------------------------------------------- helpers

  private async getJson(url: string): Promise<any> {
    const res = await fetchApi(url);
    if (!res.ok) {
      throw new Error(`JadeScrolls request failed (${res.status}): ${url}`);
    }
    return res.json();
  }

  private slugFromPath(path: string): string {
    // Paths look like "/novel/<slug>" or "/novel/<slug>/<chapter-slug>".
    const parts = path.split('/').filter(Boolean);
    return parts[0] === 'novel' ? parts[1] : parts[0];
  }

  private toNovelItem(n: any): Plugin.NovelItem {
    this.authorCache[n.slug] = n.author_name || '';
    return {
      name: n.title,
      path: `/novel/${n.slug}`,
      cover: n.cover_image || defaultCover,
    };
  }

  // ---------------------------------------------------------------- browse

  async popularNovels(
    pageNo: number,
    { filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    let url = `${API}/novels/list?sortBy=views&sortOrder=desc&limit=20&page=${pageNo}`;
    const genre = filters?.genre?.value;
    if (genre) url += `&genre=${genre}`;

    const json = await this.getJson(url);
    const totalPages = json?.meta?.total_pages ?? 1;
    if (pageNo > totalPages) return [];
    return (json.data || []).map((n: any) => this.toNovelItem(n));
  }

  // ---------------------------------------------------------------- novel page

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const slug = this.slugFromPath(novelPath);
    const n = await this.getJson(
      `${API}/novels?slug=${encodeURIComponent(slug)}`,
    );

    const genreNames: string[] = [];
    for (const g of [...(n.genres || []), ...(n.sub_genres || [])]) {
      if (g?.name && !genreNames.includes(g.name)) genreNames.push(g.name);
    }

    const novel: Plugin.SourceNovel = {
      path: `/novel/${slug}`,
      name: n.title,
      cover: n.cover_image || defaultCover,
      author: n.author_name || undefined,
      summary: htmlToText(n.synopsis),
      genres: genreNames.join(', '),
      status:
        n.metadata?.release_status === 'COMPLETED'
          ? NovelStatus.Completed
          : NovelStatus.Ongoing,
      chapters: await this.loadChapters(n.id, slug),
    };
    return novel;
  }

  private chapterListUrl(
    novelId: string,
    page: number,
    volumeId?: string,
  ): string {
    let url =
      `${API}/novels-chapter/${novelId}/chapters/list` +
      `?limit=150&page=${page}&novelId=${novelId}`;
    if (volumeId) url += `&volumeId=${volumeId}`;
    url += '&status=PUBLISHED&isDeleted=false&sortOrder=asc';
    return url;
  }

  private async loadChapters(
    novelId: string,
    slug: string,
  ): Promise<Plugin.ChapterItem[]> {
    // The site splits chapters into volumes; skip empty ones.
    let volumeIds: (string | undefined)[] = [];
    try {
      const vols = await this.getJson(
        `${API}/novels/${novelId}/volume/list?limit=1000&page=1&novelId=${novelId}&sortOrder=asc`,
      );
      volumeIds = (vols.data || [])
        .filter((v: any) => v.chapter_count > 0)
        .sort((a: any, b: any) => a.volume_no - b.volume_no)
        .map((v: any) => v.id);
    } catch (e) {
      // fall through to the no-volume request below
    }
    if (!volumeIds.length) volumeIds = [undefined];

    const chapters: Plugin.ChapterItem[] = [];

    for (const volumeId of volumeIds) {
      const first = await this.getJson(this.chapterListUrl(novelId, 1, volumeId));
      const pages: any[] = [first];

      const totalPages = first?.meta?.total_pages ?? 1;
      if (totalPages > 1) {
        const rest = await Promise.all(
          Array.from({ length: totalPages - 1 }, (_, i) =>
            this.getJson(this.chapterListUrl(novelId, i + 2, volumeId)),
          ),
        );
        pages.push(...rest);
      }

      for (const page of pages) {
        for (const c of page.data || []) {
          chapters.push({
            // Anything that is not FREE needs coins or a subscription on the site.
            name: c.type === 'FREE' ? c.title : `🔒 ${c.title}`,
            path: `/novel/${slug}/${c.slug}`,
            releaseTime: c.publish_at,
            chapterNumber: c.chapter_number,
          });
        }
      }
    }

    return chapters;
  }

  // ---------------------------------------------------------------- chapter

  async parseChapter(chapterPath: string): Promise<string> {
    const parts = chapterPath.split('/').filter(Boolean);
    // ["novel", "<novel-slug>", "<chapter-slug>"]
    const novelSlug = parts[1];
    const chapterSlug = parts[2];

    const res = await fetchApi(
      `${API}/novels-chapter/${encodeURIComponent(novelSlug)}/chapters/${encodeURIComponent(chapterSlug)}`,
    );
    if (!res.ok) {
      return `<p>This chapter could not be loaded (error ${res.status}). It may be locked and need coins or a subscription on ${SITE}.</p>`;
    }
    const chapter: any = await res.json();

    if (!chapter.content) {
      return `<p>This chapter has no readable text. It may be locked and need coins or a subscription on ${SITE}.</p>`;
    }

    let html: string = chapter.content;
    if (chapter.author_note) {
      html += `<hr><p><strong>Author's note</strong></p>${chapter.author_note}`;
    }
    return html;
  }

  // ---------------------------------------------------------------- search

  // The site's own search request was not captured, so search works by loading
  // the whole catalogue once (about 200 novels) and filtering it here.
  private async loadCatalogue(): Promise<Plugin.NovelItem[]> {
    if (this.novelCache) return this.novelCache;

    const items: Plugin.NovelItem[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const json = await this.getJson(
        `${API}/novels/list?sortBy=views&sortOrder=desc&limit=50&page=${page}`,
      );
      for (const n of json.data || []) items.push(this.toNovelItem(n));
      totalPages = json?.meta?.total_pages ?? 1;
      page++;
    } while (page <= totalPages);

    this.novelCache = items;
    return items;
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];
    const term = searchTerm.trim().toLowerCase();
    if (!term) return [];

    const all = await this.loadCatalogue();
    return all.filter(n => {
      const slug = n.path.split('/').pop() || '';
      const author = (this.authorCache[slug] || '').toLowerCase();
      return n.name.toLowerCase().includes(term) || author.includes(term);
    });
  }
}

export default new JadeScrollsPlugin();
