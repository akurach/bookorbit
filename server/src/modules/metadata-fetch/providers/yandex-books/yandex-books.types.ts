export interface YandexBookPerson {
  name?: unknown;
}

export interface YandexBookCover {
  url?: unknown;
  large?: unknown;
  small?: unknown;
  ratio?: unknown;
}

export interface YandexBookPublisher {
  name?: unknown;
}

export interface YandexBookTopic {
  name?: unknown;
  title?: unknown;
}

export interface YandexBook {
  uuid?: unknown;
  name?: unknown;
  title?: unknown;
  annotation?: unknown;
  editorAnnotation?: unknown;
  editor_annotation?: unknown;
  authors?: unknown;
  authors_objects?: unknown;
  publisher?: unknown;
  publishers?: unknown;
  topics?: unknown;
  cover?: unknown;
  language?: unknown;
  paper_pages?: unknown;
  publication_date?: unknown;
  original_year?: unknown;
}

export interface YandexBooksSearchPageEntry {
  __typename?: unknown;
  book?: unknown;
}

export interface YandexBooksSearchResponse {
  data?: {
    search?: {
      page?: unknown;
    };
  };
  errors?: unknown;
}

export interface YandexBookLookupResponse {
  book?: unknown;
}
