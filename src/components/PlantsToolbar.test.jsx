import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PlantsToolbar from './PlantsToolbar';

// CRA's SVG test transformer emits React 18 elements; use the React 19 runtime.
jest.mock('../i/icons/grid-3-columns.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('../i/icons/grid-4-columns.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('../i/icons/grid-8-columns.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('../i/icons/grid-1-column.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('../i/icons/grid-2-columns.svg', () => ({ ReactComponent: () => <svg /> }));

function renderToolbar(overrides = {}) {
    const onAdd = jest.fn();
    function Harness() {
        const [searchQuery, setSearchQuery] = useState('');
        const [sortMode, setSortMode] = useState('date');
        const [showOnlyHidden, setShowOnlyHidden] = useState(false);
        const [showOnlyNeedReplant, setShowOnlyNeedReplant] = useState(false);
        const [showTrash, setShowTrash] = useState(false);
        const [gridColumns, setGridColumns] = useState(4);
        const [mobileCompact, setMobileCompact] = useState(false);
        return <MemoryRouter><PlantsToolbar {...{ count: 265, trashCount: 41, onAdd, searchQuery, setSearchQuery, sortMode, setSortMode, showOnlyHidden, setShowOnlyHidden, showOnlyNeedReplant, setShowOnlyNeedReplant, showTrash, setShowTrash, gridColumns, setGridColumns, mobileCompact, setMobileCompact, ...overrides }} /></MemoryRouter>;
    }
    render(<Harness />);
    return { onAdd };
}

test('opens adding and links to the account', () => {
    const { onAdd } = renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: 'Добавить растение' }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Личный кабинет' })).toHaveAttribute('href', '/account');
});

test('updates and clears search and changes sorting', () => {
    renderToolbar();
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'Фикус' } });
    expect(search).toHaveValue('Фикус');
    fireEvent.click(screen.getByRole('button', { name: 'Очистить поиск' }));
    expect(search).toHaveValue('');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'watering' } });
    expect(screen.getByRole('combobox')).toHaveValue('watering');
});

test('keeps filters combinable and resets them with All', () => {
    renderToolbar();
    const filters = within(screen.getByRole('group', { name: 'Фильтры растений' }));
    const all = filters.getByRole('button', { name: /Все растения/ });
    const hidden = filters.getByRole('button', { name: 'Скрытые' });
    const replant = filters.getByRole('button', { name: /На пересадку/ });
    const trash = filters.getByRole('button', { name: 'Корзина · 41' });
    fireEvent.click(hidden);
    fireEvent.click(replant);
    expect(hidden).toHaveAttribute('aria-pressed', 'true');
    expect(replant).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(trash);
    expect(trash).toHaveAttribute('aria-pressed', 'true');
    expect(all).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(all);
    expect(all).toHaveAttribute('aria-pressed', 'true');
    expect(hidden).toHaveAttribute('aria-pressed', 'false');
    expect(replant).toHaveAttribute('aria-pressed', 'false');
    expect(trash).toHaveAttribute('aria-pressed', 'false');
});

test('changes desktop and mobile views independently', () => {
    renderToolbar();
    const desktop = screen.getByRole('button', { name: 'Компактные: 8 карточек в ряду' });
    const mobile = screen.getByRole('button', { name: 'Компактный вид: 2 карточки в ряду' });
    fireEvent.click(desktop);
    expect(desktop).toHaveAttribute('aria-pressed', 'true');
    expect(mobile).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(mobile);
    expect(desktop).toHaveAttribute('aria-pressed', 'true');
    expect(mobile).toHaveAttribute('aria-pressed', 'true');
});
